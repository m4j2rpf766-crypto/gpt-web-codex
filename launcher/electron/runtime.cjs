const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const { CURRENT_CONNECTOR_NAME, connectorNameForSetup } = require("./connector-identity.cjs");
const { runtimeInvocation } = require("./runtime-command.cjs");
const { redactText } = require("./logging.cjs");
const { DETACH_OWNED_CHILD, terminateOwnedProcessTree } = require("./process-tree.cjs");

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const SETUP_TIMEOUT_MS = 10 * 60_000;

function resolveUserPath(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function collect(stream, chunks, onLine) {
  let buffered = "";
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= MAX_CAPTURE_BYTES) chunks.push(chunk);
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trimEnd();
      buffered = buffered.slice(newline + 1);
      if (line) onLine(line);
    }
  });
}

class RuntimeHost {
  constructor({ app, logger, sourceRoot, installedRuntimeRoot, runtimeRootProvider, publishOperation, supervisor }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.installedRuntimeRoot = installedRuntimeRoot;
    this.runtimeRootProvider = runtimeRootProvider;
    this.publishOperation = publishOperation;
    this.supervisor = supervisor;
    this.active = null;
    this.activeChild = null;
    this.cleanupEphemeralSecrets();
  }

  cleanupEphemeralSecrets() {
    const directory = path.join(this.app.getPath("userData"), "secrets");
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && /^runtime-key-[a-f0-9]{32}\.tmp$/.test(entry.name)) {
          fs.rmSync(path.join(directory, entry.name), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.logger.warn("runtime.secret_cleanup_failed", { message: String(error) });
    }
  }

  currentOperation() {
    const liveChild = this.activeChild && this.activeChild.exitCode === null && this.activeChild.signalCode === null;
    return this.active || (liveChild ? "runtime process shutdown" : null);
  }

  command(args) {
    if (this.runtimeRootProvider) this.installedRuntimeRoot = this.runtimeRootProvider();
    return runtimeInvocation({
      app: this.app,
      sourceRoot: this.sourceRoot,
      installedRuntimeRoot: this.installedRuntimeRoot,
      args,
    });
  }

  runtimeConfigSnapshot() {
    let config;
    try { config = this.supervisor.readSetupConfig(); }
    catch { return { configured: false, mode: "full", config: null }; }
    if (!config) return { configured: false, mode: "full", config: null };
    return { configured: true, mode: config.mode, config };
  }

  mcpCredentialsConfigured() {
    const config = this.runtimeConfigSnapshot().config;
    const tunnel = config?.mode === "full" ? config.tunnel : null;
    return Boolean(tunnel
      && /^tunnel_[a-f0-9]{32}$/.test(tunnel.tunnelId)
      && typeof tunnel.runtimeKeyFile === "string"
      && path.isAbsolute(tunnel.runtimeKeyFile)
      && fs.existsSync(tunnel.runtimeKeyFile));
  }

  browserConnectorName() {
    const config = this.runtimeConfigSnapshot().config;
    return connectorNameForSetup(config?.appName || CURRENT_CONNECTOR_NAME);
  }

  mcpConnectorName() { return this.browserConnectorName(); }

  async run(name, args, { message = name, successMessage = "Completed", timeoutMs = 75_000 } = {}) {
    if (this.currentOperation()) throw new Error(`Another launcher operation is active: ${this.currentOperation()}`);
    this.active = name;
    this.publishOperation?.({ name, status: "running", message });
    this.logger.info("runtime.operation_started", { name, args: args.map((part) => /key|token/i.test(part) ? "[redacted]" : part) });
    try {
      const invocation = this.command(args);
      const result = await new Promise((resolve, reject) => {
        const child = spawn(invocation.executable, invocation.args, {
          cwd: invocation.cwd,
          detached: DETACH_OWNED_CHILD,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        this.activeChild = child;
        const stdout = [];
        const stderr = [];
        collect(child.stdout, stdout, (line) => {
          this.logger.info("runtime.stdout", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        });
        collect(child.stderr, stderr, (line) => {
          this.logger.warn("runtime.stderr", { operation: name, line });
          this.publishOperation?.({ name, status: "running", message: redactText(line) });
        });
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { terminateOwnedProcessTree(child); } catch {}
        }, timeoutMs);
        child.once("error", reject);
        child.once("exit", (code) => {
          clearTimeout(timer);
          this.activeChild = null;
          if (timedOut) return reject(new Error(`${name} timed out after ${timeoutMs}ms`));
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          if (code !== 0) return reject(new Error(err.trim() || out.trim() || `exit ${code}`));
          resolve({ stdout: out, stderr: err });
        });
      });
      this.logger.info("runtime.operation_completed", { name });
      this.publishOperation?.({ name, status: "completed", message: successMessage });
      return result;
    } catch (error) {
      const messageText = redactText(error instanceof Error ? error.message : String(error));
      this.logger.error("runtime.operation_failed", { name, message: messageText });
      this.publishOperation?.({ name, status: "failed", message: messageText });
      throw new Error(messageText);
    } finally {
      this.active = null;
    }
  }

  async doctor() {
    try {
      const result = await this.run("doctor", ["doctor", "--json"], { message: "Checking pure MCP runtime" });
      return JSON.parse(result.stdout);
    } catch (error) {
      return { ok: false, checks: [{ id: "runtime", status: "error", message: error instanceof Error ? error.message : String(error) }] };
    }
  }

  async upgradeManagedRuntime() {
    const existing = this.runtimeConfigSnapshot();
    if (!existing.configured || existing.mode !== "full") return { updated: false, needsSetup: true };
    const currentVersion = this.app.getVersion();
    if (existing.config.releaseVersion === currentVersion && existing.config.browserHost === "none") return { updated: false };
    await this.setupMcp({});
    return {
      updated: true,
      mode: "full",
      fromVersion: existing.config.releaseVersion,
      toVersion: currentVersion,
      connectorMigrated: existing.config.browserHost !== "none",
    };
  }

  async setupMcp({ tunnelId = "", runtimeKey = "", replace = false } = {}) {
    const reuse = replace !== true && this.mcpCredentialsConfigured();
    if (!reuse && !/^tunnel_[a-f0-9]{32}$/.test(tunnelId)) throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters");
    if (!reuse && (typeof runtimeKey !== "string" || runtimeKey.trim().length < 20)) throw new Error("A Tunnels Read + Use runtime key is required");
    const args = ["setup", "--full", "--mcp-only", "--app-name", this.browserConnectorName(), "--acknowledge-unofficial", "--replace-legacy-runtime"];
    let temporaryKey = null;
    if (!reuse) {
      const directory = path.join(this.app.getPath("userData"), "secrets");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      temporaryKey = path.join(directory, `runtime-key-${randomBytes(16).toString("hex")}.tmp`);
      fs.writeFileSync(temporaryKey, runtimeKey.trim(), { flag: "wx", mode: 0o600 });
      args.push("--tunnel-id", tunnelId, "--runtime-key-file", temporaryKey);
    }
    await this.supervisor.stopForSetup();
    try {
      const result = await this.run("mcp-setup", args, {
        message: reuse ? "Migrating saved tunnel to pure MCP mode" : "Connecting pure MCP tunnel",
        successMessage: "Pure MCP tools are ready",
        timeoutMs: SETUP_TIMEOUT_MS,
      });
      const runtime = await this.supervisor.startIfConfigured();
      if (runtime.status !== "ready") throw new Error(`Pure MCP runtime is ${runtime.status}: ${runtime.detail || "not ready"}`);
      return result;
    } finally {
      if (temporaryKey) fs.rmSync(temporaryKey, { force: true });
    }
  }
}

module.exports = { RuntimeHost, resolveUserPath };
