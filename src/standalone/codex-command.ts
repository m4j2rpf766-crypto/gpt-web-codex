import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LunaJob } from "./types";

export interface CodexInvocation {
  command: string;
  args: string[];
}

function candidateExecutables(): string[] {
  const explicit = process.env.WEBGPT_CODEX_EXECUTABLE?.trim();
  const appData = process.env.APPDATA?.trim();
  const npmNative = appData
    ? join(appData, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe")
    : undefined;
  const discovered = typeof Bun !== "undefined" ? Bun.which("codex") : null;
  return [explicit, npmNative, discovered]
    .filter((value): value is string => Boolean(value))
    .map(value => resolve(value));
}

export function resolveCodexExecutable(): string {
  for (const candidate of candidateExecutables()) {
    if (existsSync(candidate) && !candidate.toLowerCase().endsWith(".ps1")) return candidate;
  }
  throw new Error("Codex executable was not found. Set WEBGPT_CODEX_EXECUTABLE to a native Codex executable.");
}

export function buildCodexInvocation(
  job: LunaJob,
  lunaSessionId?: string,
  command = resolveCodexExecutable(),
  platform = process.platform,
): CodexInvocation {
  const shared = [
    "--json",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--color", "never",
    "--model", job.model,
    "--cd", job.cwd,
    "--config", "approval_policy=\"never\"",
    "--config", `model_reasoning_effort=${JSON.stringify(job.reasoning)}`,
  ];
  if (job.sandbox === "danger-full-access") {
    shared.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    shared.push("--sandbox", job.sandbox);
    // --ignore-user-config deliberately isolates Luna from the user's Codex routing and
    // settings. On Windows it also removes the sandbox backend selection, which makes a
    // nominal workspace-write turn behave as read-only unless it is restored per process.
    if (platform === "win32") shared.push("--config", "windows.sandbox=\"unelevated\"");
    if (job.sandbox === "workspace-write") {
      shared.push("--config", "sandbox_workspace_write.network_access=true");
    }
  }
  if (job.fast) shared.push("--config", "service_tier=\"fast\"");
  const args = lunaSessionId
    ? ["exec", ...shared, "resume", lunaSessionId, "-"]
    : ["exec", ...shared, "-"];
  return { command, args };
}
