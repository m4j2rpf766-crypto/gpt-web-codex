const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStateStore } = require("../electron/state.cjs");

test("launcher state persists only pure MCP preferences atomically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-web-codex-state-"));
  const file = path.join(root, "state.json");
  try {
    const store = createStateStore(file);
    assert.deepEqual(store.read(), {
      version: 1,
      language: null,
      keepRunningOnClose: true,
      mcpGuideStep: 0,
    });
    store.update({
      language: "zh-CN",
      keepRunningOnClose: false,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: true,
    });
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: "zh-CN",
      keepRunningOnClose: false,
      mcpGuideStep: 0,
      mcpRuntimeInstalled: true,
      mcpSetupComplete: true,
    });
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
    assert.equal(fs.readdirSync(root).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy browser and onboarding state is removed during migration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-web-codex-migration-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "zh-CN",
      onboardingComplete: true,
      githubOpened: true,
      xOpened: true,
      autoStart: true,
      bridgeEnabled: true,
      showBrowserDuringTurns: true,
      browserSmokePassed: true,
      sidebarOpen: false,
      sidebarWidth: 310,
      sessionRefreshReminderAt: "2026-08-14T00:00:00.000Z",
      conversationHistory: [{ id: "old-chat" }],
      keepRunningOnClose: false,
      mcpGuideStep: 2,
    }));
    const state = createStateStore(file).read();
    assert.deepEqual(state, {
      version: 1,
      language: "zh-CN",
      keepRunningOnClose: false,
      mcpGuideStep: 2,
    });
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const retired of [
      "onboardingComplete", "githubOpened", "xOpened", "autoStart", "bridgeEnabled",
      "showBrowserDuringTurns", "browserSmokePassed", "sidebarOpen", "sidebarWidth",
      "sessionRefreshReminderAt", "conversationHistory",
    ]) assert.equal(Object.hasOwn(persisted, retired), false, retired);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid pure MCP preferences are repaired", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-web-codex-corrupt-"));
  const file = path.join(root, "state.json");
  try {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      language: "fr",
      keepRunningOnClose: "yes",
      mcpGuideStep: 99,
      coreSetupComplete: "yes",
    }));
    assert.deepEqual(createStateStore(file).read(), {
      version: 1,
      language: null,
      keepRunningOnClose: true,
      mcpGuideStep: 0,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
