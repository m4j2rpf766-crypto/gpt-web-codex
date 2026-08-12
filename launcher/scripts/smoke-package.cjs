const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const launcherRoot = path.resolve(__dirname, "..");
const artifactsDirectory = path.join(launcherRoot, "artifacts");
const launcherManifest = JSON.parse(
  fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"),
);
const expectedVersion = launcherManifest.version;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-web-codex-package-smoke-"));
const markerPath = path.join(scratch, "ready.json");
const coreHome = path.join(scratch, "core-home");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || scratch,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeout || 45_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${result.stderr?.trim() || result.stdout?.trim() || "no output"}`,
    );
  }
}

function artifact(pattern, label) {
  const matches = fs.readdirSync(artifactsDirectory)
    .filter((name) => pattern.test(name))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${artifactsDirectory}; found ${matches.join(", ") || "none"}`);
  }
  return path.join(artifactsDirectory, matches[0]);
}

function smokeEnvironment() {
  return {
    ...process.env,
    CODEX_WEB_GPT_LAUNCHER_DATA_DIR: path.join(scratch, "launcher-data"),
    CODEX_CHATGPT_WEB_HOME: coreHome,
    CODEX_HOME: path.join(scratch, "codex-home"),
    CODEX_WEB_GPT_SMOKE_FILE: markerPath,
  };
}

try {
  let executable;
  let command;
  let args;
  const env = smokeEnvironment();

  if (process.platform === "darwin") {
    const archive = artifact(/-mac-(?:arm64|x64)\.zip$/, "macOS launcher archive");
    const stage = path.join(scratch, "stage");
    fs.mkdirSync(stage);
    run("ditto", ["-x", "-k", archive, stage]);
    executable = path.join(stage, "GPT Web Codex.app", "Contents", "MacOS", "GPT Web Codex");
    command = executable;
    args = ["--launcher-smoke-test"];
  } else if (process.platform === "linux") {
    executable = artifact(/-linux-x64\.AppImage$/, "Linux AppImage");
    fs.chmodSync(executable, 0o755);
    command = "xvfb-run";
    args = ["-a", executable, "--launcher-smoke-test"];
    env.APPIMAGE_EXTRACT_AND_RUN = "1";
  } else if (process.platform === "win32") {
    const installer = artifact(/-win-x64\.exe$/, "Windows installer");
    run(installer, ["/S"], { timeout: 120_000 });
    executable = path.join(
      process.env.LOCALAPPDATA || "",
      "Programs",
      launcherManifest.name,
      `${launcherManifest.build.productName}.exe`,
    );
    command = executable;
    args = ["--launcher-smoke-test"];
  } else {
    throw new Error(`Unsupported package smoke platform: ${process.platform}`);
  }

  if (!fs.existsSync(executable)) throw new Error(`Packaged launcher executable is missing: ${executable}`);
  run(command, args, { env });
  if (!fs.existsSync(markerPath)) throw new Error("Packaged launcher did not write its readiness marker");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (marker.ok !== true
    || marker.packaged !== true
    || marker.runtimeVerified !== true
    || marker.version !== expectedVersion
    || marker.platform !== process.platform) {
    throw new Error(`Unexpected packaged launcher marker: ${JSON.stringify(marker)}`);
  }
  const installedRuntime = path.join(
    coreHome,
    "versions",
    `${expectedVersion}-${process.platform}-${process.arch}`,
  );
  const installedManifest = JSON.parse(
    fs.readFileSync(path.join(installedRuntime, "manifest.json"), "utf8"),
  );
  if (installedManifest.appVersion !== expectedVersion
    || installedManifest.platform !== process.platform
    || installedManifest.arch !== process.arch
    || !/^[a-f0-9]{64}$/.test(installedManifest.bundleId)) {
    throw new Error(`Packaged launcher installed the wrong durable runtime: ${JSON.stringify(installedManifest)}`);
  }
  process.stdout.write(`PACKAGED_LAUNCHER_SMOKE_OK ${process.platform}/${process.arch}\n`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
