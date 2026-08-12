const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RuntimeHost } = require("../electron/runtime.cjs");

function hostFor(config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-web-codex-pure-mcp-"));
  const key = path.join(root, "runtime.key");
  fs.writeFileSync(key, "secret");
  const normalized = config ? { ...config, tunnel: { ...config.tunnel, runtimeKeyFile: key } } : null;
  const host = new RuntimeHost({
    app: { getPath: () => root, getVersion: () => "2.2.0", isPackaged: false },
    logger: { info() {}, warn() {}, error() {} },
    sourceRoot: root,
    installedRuntimeRoot: null,
    runtimeRootProvider: null,
    publishOperation() {},
    supervisor: { readSetupConfig: () => normalized },
  });
  return { host, root };
}

test("pure MCP runtime recognizes saved tunnel credentials without browser state", () => {
  const { host, root } = hostFor({
    mode: "full",
    browserHost: "none",
    appName: "WebGPT Luna Standalone",
    tunnel: { tunnelId: `tunnel_${"a".repeat(32)}` },
  });
  assert.equal(host.mcpCredentialsConfigured(), true);
  assert.equal(host.browserConnectorName(), "WebGPT Luna Standalone");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pure MCP runtime rejects missing credentials", async () => {
  const { host, root } = hostFor(null);
  assert.equal(host.mcpCredentialsConfigured(), false);
  await assert.rejects(host.setupMcp({ tunnelId: "bad", runtimeKey: "short", replace: true }), /Tunnel ID/);
  fs.rmSync(root, { recursive: true, force: true });
});
