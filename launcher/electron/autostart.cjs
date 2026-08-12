const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const LINUX_DESKTOP_NAME = "dev.codexwebgpt.launcher.desktop";

function linuxDesktopPath() {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "autostart", LINUX_DESKTOP_NAME);
}

function disableLegacyAutostart(app) {
  if (!app.isPackaged) return { supported: false, disabled: false };
  if (process.platform === "linux") {
    fs.rmSync(linuxDesktopPath(), { force: true });
    return { supported: true, disabled: true };
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: false,
      openAsHidden: false,
      args: ["--hidden"],
    });
    return { supported: true, disabled: true };
  }
  return { supported: false, disabled: false };
}

module.exports = {
  LINUX_DESKTOP_NAME,
  disableLegacyAutostart,
  linuxDesktopPath,
};
