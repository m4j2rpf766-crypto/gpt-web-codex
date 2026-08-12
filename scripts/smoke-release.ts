import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VERSION } from "../src/version";

const sourceBundle = resolve(process.argv[2] ?? "dist/runtime");
const sourceRoot = resolve(import.meta.dir, "..");
const root = join(homedir(), `.gpt-web-codex-release-smoke-${process.pid}-${Date.now()}`);
const firstLocation = join(root, "first-location");
const runtimeRoot = join(root, "relocated-runtime");

try {
  cpSync(sourceBundle, firstLocation, { recursive: true });
  renameSync(firstLocation, runtimeRoot);
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
  if (manifest.schemaVersion !== 1
    || manifest.appVersion !== VERSION
    || typeof manifest.entrypoint !== "string"
    || !/^[a-f0-9]{64}$/.test(String(manifest.bundleId ?? ""))) {
    throw new Error(`Unexpected runtime manifest: ${JSON.stringify(manifest)}`);
  }
  const executable = join(runtimeRoot, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  const entrypoint = join(runtimeRoot, manifest.entrypoint);
  const cliBundle = readFileSync(entrypoint, "utf8");
  for (const forbidden of [sourceRoot, dirname(sourceBundle)]) {
    if (cliBundle.includes(forbidden)) throw new Error(`Runtime artifact embeds build path: ${forbidden}`);
  }
  const version = Bun.spawnSync([executable, entrypoint, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (version.exitCode !== 0 || version.stdout.toString().trim() !== VERSION) {
    throw new Error(`Relocated runtime failed: ${version.stderr.toString()}`);
  }

  const transport = new StdioClientTransport({
    command: executable,
    args: [entrypoint, "mcp", "--state-path", join(root, "standalone-state.json")],
    cwd: runtimeRoot,
    stderr: "pipe",
  });
  const client = new Client({ name: "gpt-web-codex-release-smoke", version: VERSION });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = new Set(tools.tools.map(tool => tool.name));
    for (const required of ["codexluna_start", "codexluna_status", "file_read", "terminal_start"]) {
      if (!names.has(required)) throw new Error(`Relocated MCP runtime is missing ${required}`);
    }
    const missingOutputSchema = tools.tools.filter(tool => !tool.outputSchema).map(tool => tool.name);
    if (missingOutputSchema.length) {
      throw new Error(`Relocated MCP runtime has tools without outputSchema: ${missingOutputSchema.join(", ")}`);
    }
    const missingNoAuth = tools.tools.filter(tool => !Array.isArray(tool._meta?.securitySchemes)).map(tool => tool.name);
    if (missingNoAuth.length) {
      throw new Error(`Relocated MCP runtime has tools without noauth metadata: ${missingNoAuth.join(", ")}`);
    }
    const fileRead = tools.tools.find(tool => tool.name === "file_read");
    if (fileRead?._meta?.["openai/outputTemplate"]) {
      throw new Error("file_read must not mount the image-preview widget for text results");
    }
    const initReasoning = tools.tools.find(tool => tool.name === "codexluna_init")
      ?.inputSchema.properties?.reasoning_effort as { enum?: unknown[]; default?: unknown } | undefined;
    if (!initReasoning?.enum?.includes("none")) {
      throw new Error("codexluna_init does not expose reasoning_effort=none");
    }
    if (initReasoning.default !== "low") {
      throw new Error("codexluna_init does not default reasoning_effort to low");
    }
  } finally {
    await client.close();
  }
  process.stdout.write("RELOCATABLE_STANDALONE_MCP_SMOKE_OK\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
