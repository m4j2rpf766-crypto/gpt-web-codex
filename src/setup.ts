import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AppConfig, RuntimeMode } from "./config";
import {
  currentRuntimeCommand,
  defaultMcpConfig,
  getConfigPath,
  loadConfigForSetup,
  resolveSetupConnectorName,
  saveConfig,
} from "./config";
import {
  assertServiceIdle,
  getServiceStatus,
  removeLegacyRuntimeArtifacts,
  uninstallService,
} from "./service";
import { connectTunnel, createTunnelConfig, installRuntimeKey, installRuntimeKeyBytes, installTunnelClient, managedRuntimeKeyPath, stopTunnel, waitForTunnelReady } from "./tunnel";
import { getTunnelServiceStatus, uninstallTunnelService } from "./tunnel-service";
import { VERSION } from "./version";

export interface SetupOptions {
  mode: RuntimeMode;
  pureMcp?: boolean;
  port?: number;
  appName?: string;
  replaceLegacyRuntime?: boolean;
  acknowledgedUnofficial?: boolean;
  tunnelId?: string;
  runtimeKeyFile?: string;
  runtimeKeyValue?: string;
}

export interface SetupResult {
  mode: RuntimeMode;
  configPath: string;
  loginCreated: boolean;
  serviceLoaded: boolean;
  tunnelReady: boolean | null;
  connectorSetupRequired: boolean;
}

export interface ExistingFullSetupCredentials {
  tunnelId: boolean;
  runtimeKey: boolean;
}

export function existingFullSetupCredentials(existing: AppConfig | undefined): ExistingFullSetupCredentials {
  const tunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  return {
    tunnelId: Boolean(tunnel?.tunnelId),
    runtimeKey: Boolean(tunnel?.runtimeKeyFile && existsSync(tunnel.runtimeKeyFile)),
  };
}

function loadExistingConfig(): AppConfig | undefined {
  if (!existsSync(getConfigPath())) return undefined;
  return loadConfigForSetup();
}

export function tunnelWorkerRuntimeChanged(before: AppConfig | undefined, after: AppConfig): boolean {
  if (!before || before.mode !== "full" || after.mode !== "full") return false;
  return before.releaseVersion !== after.releaseVersion
    || JSON.stringify(before.runtimeCommand) !== JSON.stringify(after.runtimeCommand)
    || before.brokerSocketPath !== after.brokerSocketPath;
}

export function setupProxyIsReady(
  health: Record<string, unknown>,
  config: Pick<AppConfig, "mode" | "releaseVersion">,
): boolean {
  return health.service === "codex-chatgpt-web"
    && health.status === "ok"
    && health.mode === config.mode
    && health.version === config.releaseVersion
    && health.accepting_turns === true;
}

function baseConfig(existing: AppConfig | undefined, options: SetupOptions): AppConfig {
  if (!options.pureMcp || options.mode !== "full") {
    throw new Error("This release supports only pure MCP full mode");
  }
  const config = existing ? structuredClone(existing) : defaultMcpConfig();
  config.mode = "full";
  config.releaseVersion = VERSION;
  config.runtimeCommand = currentRuntimeCommand();
  if (options.port !== undefined) {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw new Error("--port must be an integer from 1 to 65535");
    config.port = options.port;
  }
  config.browserHost = "none";
  delete config.browserHostDescriptorPath;
  config.chromeExecutablePath = "";
  config.storageStatePath = "";
  config.brokerSocketPath = "";
  config.headed = false;
  config.solAvailable = false;
  config.proAvailable = false;
  config.autoApproveToolCalls = false;
  config.appName = resolveSetupConnectorName(existing?.appName, options.appName);
  if (options.acknowledgedUnofficial) config.acknowledgedUnofficialAt = new Date().toISOString();
  if (!config.acknowledgedUnofficialAt) {
    throw new Error("Setup requires explicit acknowledgement that this is an unofficial local MCP connector. Pass --acknowledge-unofficial.");
  }
  return config;
}

async function configureTunnel(config: AppConfig, existing: AppConfig | undefined, options: SetupOptions): Promise<void> {
  if (config.mode === "browser-only") {
    delete config.tunnel;
    return;
  }
  const existingTunnel = existing?.mode === "full" ? existing.tunnel : undefined;
  const tunnelId = options.tunnelId ?? existingTunnel?.tunnelId;
  if (!tunnelId) {
    throw new Error("Full mode requires --tunnel-id. Create it at https://platform.openai.com/settings/organization/tunnels");
  }
  let runtimeKeyFile = existingTunnel?.runtimeKeyFile;
  if (!runtimeKeyFile && existsSync(managedRuntimeKeyPath())) runtimeKeyFile = managedRuntimeKeyPath();
  if (options.runtimeKeyFile) runtimeKeyFile = installRuntimeKey(options.runtimeKeyFile);
  if (options.runtimeKeyValue) runtimeKeyFile = installRuntimeKeyBytes(options.runtimeKeyValue);
  if (!runtimeKeyFile || !existsSync(runtimeKeyFile)) {
    throw new Error("Full mode requires a runtime key. Import it interactively or pass --runtime-key-file; create it at https://platform.openai.com/settings/organization/api-keys");
  }
  const installedBinary = await installTunnelClient();
  config.tunnel = createTunnelConfig({
    binaryPath: installedBinary,
    tunnelId,
    runtimeKeyFile,
    profileName: existingTunnel?.profileName,
    alias: existingTunnel?.alias,
  });
}

async function bootstrapTunnelProfile(config: AppConfig): Promise<void> {
  let bootstrapError: unknown;
  try {
    // `runtimes connect` writes the native profile and returns once its managed runtime is healthy.
    // Readiness follows after a successful control-plane poll, so setup proves it separately before
    // stopping the validation runtime. The launcher supervisor reconnects the committed profile.
    connectTunnel(config);
    const status = await waitForTunnelReady(config);
    if (!status.ok) throw new Error(`Tunnel runtime did not become healthy and ready: ${status.detail}`);
  } catch (error) {
    bootstrapError = error;
  }
  try {
    stopTunnel(config);
  } catch (stopError) {
    if (bootstrapError) {
      const primary = bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError);
      const cleanup = stopError instanceof Error ? stopError.message : String(stopError);
      throw new Error(`${primary}; temporary tunnel cleanup also failed: ${cleanup}`);
    }
    throw stopError;
  }
  if (bootstrapError) throw bootstrapError;
}

export async function setup(options: SetupOptions): Promise<SetupResult> {
  const existing = loadExistingConfig();
  const config = baseConfig(existing, options);
  const refreshTunnelWorker = tunnelWorkerRuntimeChanged(existing, config);
  if (existing && options.replaceLegacyRuntime) config.controlToken = randomBytes(32).toString("base64url");
  const beforeService = getServiceStatus();
  if (beforeService.installed || beforeService.loaded) {
    if (!existing) {
      throw new Error("A legacy background service exists without a verifiable configuration; refusing automatic migration");
    }
    if (!options.replaceLegacyRuntime) {
      throw new Error(
        "Launcher ownership migration must stop the legacy background service. "
        + "Retry from the launcher after the legacy runtime is idle.",
      );
    }
  }
  if (beforeService.loaded && !existing) {
    throw new Error("A codex-chatgpt-web service is loaded but its configuration is missing; refusing to replace an unverifiable process");
  }
  const explicitTunnelChange = Boolean(options.tunnelId || options.runtimeKeyFile || options.runtimeKeyValue);
  if (beforeService.loaded && existing) await assertServiceIdle(existing);
  await configureTunnel(config, existing, options);

  let tunnelReady: boolean | null = null;
  const profilePath = join(config.tunnel!.profileDir, `${config.tunnel!.profileName}.yaml`);
  const tunnelService = getTunnelServiceStatus();
  const needsProfile = !existsSync(profilePath);
  if (tunnelService.installed || tunnelService.loaded) await uninstallTunnelService();
  if (needsProfile || refreshTunnelWorker || explicitTunnelChange) {
    await bootstrapTunnelProfile(config);
  }
  if (beforeService.installed || beforeService.loaded) {
    await uninstallService(existing!);
  }
  saveConfig(config);
  // Keep the previous terminal runtime intact through the ownership handoff. A later launcher
  // setup removes it once the launcher-owned configuration is already the established baseline.
  const migratingTerminalRuntime = Boolean(
    existing && existing.browserHost !== config.browserHost,
  );
  if (!migratingTerminalRuntime) removeLegacyRuntimeArtifacts(config);
  return {
    mode: config.mode,
    configPath: getConfigPath(),
    loginCreated: false,
    serviceLoaded: false,
    tunnelReady,
    connectorSetupRequired: config.mode === "full",
  };
}
