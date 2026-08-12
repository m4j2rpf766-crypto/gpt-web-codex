import { existsSync, statSync } from "node:fs";
import type { AppConfig } from "./config";
import { getConfigPath, loadConfig } from "./config";
import { browserLoginStateExists, loginVerificationMarkerPath } from "./browser-login";
import { getServiceStatus } from "./service";
import { tunnelStatus } from "./tunnel";
import { getTunnelServiceStatus } from "./tunnel-service";
import { inspectLauncherBrowserHost, readLauncherBrowserHostDescriptor } from "./launcher-browser-host";

export type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  ok: boolean;
  mode?: AppConfig["mode"];
  checks: DoctorCheck[];
}

function secureFile(path: string): boolean {
  if (process.platform === "win32") return true;
  return (statSync(path).mode & 0o077) === 0;
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let config: AppConfig;
  try {
    config = loadConfig();
    checks.push({ id: "config", status: "ok", message: `Configuration is valid (${getConfigPath()})` });
  } catch (error) {
    checks.push({ id: "config", status: "error", message: "Configuration is invalid", detail: error instanceof Error ? error.message : String(error) });
    return { ok: false, checks };
  }

  if (config.browserHost === "launcher") {
    try {
      const descriptor = readLauncherBrowserHostDescriptor(config.browserHostDescriptorPath!);
      await inspectLauncherBrowserHost(config.browserHostDescriptorPath!, { timeoutMs: 30_000 });
      checks.push({
        id: "browser-host",
        status: "ok",
        message: `Embedded launcher browser is authenticated and reachable (pid ${descriptor.pid})`,
      });
    } catch (error) {
      checks.push({
        id: "browser-host",
        status: "error",
        message: "Embedded launcher browser is unavailable",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    if (!existsSync(config.chromeExecutablePath)) {
      checks.push({ id: "chrome", status: "error", message: `Chrome executable is missing: ${config.chromeExecutablePath}` });
    } else {
      checks.push({ id: "chrome", status: "ok", message: `Chrome executable found: ${config.chromeExecutablePath}` });
    }
    if (!browserLoginStateExists(config)) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login state is missing or unverified; run `gpt-web-codex login`" });
    } else if (!secureFile(config.storageStatePath)) {
      checks.push({ id: "login", status: "error", message: `ChatGPT login state is readable by other users: ${config.storageStatePath}` });
    } else if (!secureFile(loginVerificationMarkerPath(config.storageStatePath))) {
      checks.push({ id: "login", status: "error", message: "ChatGPT login verification marker is readable by other users" });
    } else {
      checks.push({ id: "login", status: "ok", message: "ChatGPT login state has authenticated browser evidence" });
    }
  }

  checks.push({
    id: "standalone-mcp",
    status: "ok",
    message: "Standalone MCP exposes codexluna, file, and terminal tools without a Codex model route",
  });

  const service = getServiceStatus();
  if (config.browserHost === "launcher") {
    checks.push(service.installed || service.loaded
      ? {
          id: "service",
          status: "warning",
          message: "A legacy OS background service still exists; rerun launcher setup to migrate ownership",
          detail: JSON.stringify(service),
        }
      : { id: "service", status: "ok", message: "No legacy Responses background service is installed" });
  } else if (!service.supported) {
    checks.push({ id: "service", status: "warning", message: "Managed service is unavailable on this OS; keep `serve` running manually" });
  } else if (!service.installed || !service.loaded) {
    checks.push({ id: "service", status: "error", message: "macOS background service is not installed and loaded" });
  } else {
    checks.push({ id: "service", status: "ok", message: "macOS background service is loaded" });
  }
  if (config.mode === "full") {
    const settings = config.tunnel!;
    if (!existsSync(settings.binaryPath)) {
      checks.push({ id: "tunnel-binary", status: "error", message: `tunnel-client is missing: ${settings.binaryPath}` });
    } else {
      checks.push({ id: "tunnel-binary", status: "ok", message: "Pinned openai/tunnel-client binary is installed" });
    }
    if (!existsSync(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file is missing" });
    } else if (!secureFile(settings.runtimeKeyFile)) {
      checks.push({ id: "tunnel-key", status: "error", message: "Tunnel runtime key file has unsafe permissions" });
    } else {
      checks.push({ id: "tunnel-key", status: "ok", message: "Tunnel runtime key is stored privately" });
    }
    const tunnelService = getTunnelServiceStatus();
    if (config.browserHost === "launcher") {
      checks.push(tunnelService.installed || tunnelService.loaded
        ? {
            id: "tunnel-service",
            status: "warning",
            message: "A legacy OS tunnel service still exists; rerun launcher MCP setup to migrate ownership",
            detail: JSON.stringify(tunnelService),
          }
        : { id: "tunnel-service", status: "ok", message: "Launcher owns the tunnel runtime" });
    } else {
      checks.push(tunnelService.installed && tunnelService.loaded && tunnelService.running
        ? { id: "tunnel-service", status: "ok", message: "macOS tunnel service is installed, loaded, and running" }
        : { id: "tunnel-service", status: "error", message: "macOS tunnel service is not fully running", detail: JSON.stringify(tunnelService) });
    }
    const runtime = tunnelStatus(config);
    checks.push(runtime.ok
      ? { id: "tunnel-runtime", status: "ok", message: "Tunnel runtime reports healthy and ready" }
      : { id: "tunnel-runtime", status: "error", message: "Tunnel runtime is not ready", detail: runtime.detail });
    checks.push({
      id: "connector",
      status: "warning",
      message: `Local checks cannot prove that ChatGPT connector ${JSON.stringify(config.appName)} is attached to this tunnel`,
      detail: "Verify it once at https://chatgpt.com/#settings/Plugins while the tunnel is ready.",
    });
  } else {
    checks.push({ id: "tools", status: "warning", message: "The MCP tool contract is available locally, but ChatGPT needs full mode and a tunnel to call it" });
  }

  return {
    ok: !checks.some(check => check.status === "error"),
    mode: config.mode,
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon: Record<CheckStatus, string> = { ok: "✓", warning: "!", error: "✗" };
  const lines = report.checks.flatMap(check => [
    `${icon[check.status]} ${check.message}`,
    ...(check.detail ? [`  ${check.detail}`] : []),
  ]);
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
