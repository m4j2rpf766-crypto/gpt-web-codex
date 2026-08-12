const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = fs.readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron", "preload.cjs"), "utf8");
const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");

test("launcher is a pure MCP control center", () => {
  assert.doesNotMatch(main, /BrowserHost|BrowserControlServer|remote-debugging-port|WebContentsView/);
  assert.doesNotMatch(preload, /browser-(?:show|login|navigate|new-conversation)|onBrowserState/);
  assert.doesNotMatch(app, /BrowserSurface|setBrowserBounds|newConversation/);
  assert.match(main, /standaloneOnly: true/);
  assert.match(app, /纯 MCP 启动器|Pure MCP launcher/);
});

test("retired embedded-browser modules are removed", () => {
  for (const name of ["browser-host.cjs", "browser-helper-verifier.cjs", "control-server.cjs", "web-session.cjs"]) {
    assert.equal(fs.existsSync(path.join(root, "electron", name)), false, name);
  }
});
