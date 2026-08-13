import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { buildCodexInvocation } from "./codex-command";
import { terminateOwnedProcessTree } from "./process-tree";
import { defaultStandaloneLogDir, LunaStateStore } from "./state-store";
import type { LunaJob, StartLunaJobInput } from "./types";

type SpawnCodex = (command: string, args: string[], cwd: string) => ChildProcessWithoutNullStreams;

function defaultSpawn(command: string, args: string[], cwd: string): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32",
  });
}

function validateSessionId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,256}$/.test(id)) throw new Error("web_session_id is invalid");
  return id;
}

function eventText(event: Record<string, unknown>): string | undefined {
  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") return item.text;
  }
  return undefined;
}

function eventMutates(event: Record<string, unknown>): boolean {
  if (!event.item || typeof event.item !== "object") return false;
  const type = String((event.item as Record<string, unknown>).type ?? "");
  return type === "file_change" || type === "command_execution";
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const IMAGE_REQUEST = /(?:图片|图像|照片|截图|预览|显示.{0,16}(?:png|jpe?g|gif|webp)|\b(?:image|photo|picture|screenshot|preview)\b)/i;

function requestedImagePreview(prompt: string): boolean {
  return IMAGE_REQUEST.test(prompt);
}

function imagePaths(value: string): string[] {
  const matches = value.match(/[A-Za-z]:\\[^\r\n"'<>|?*`]+?\.(?:png|jpe?g|gif|webp)|\/(?:[^\r\n"'<>`]| (?![-*]))+?\.(?:png|jpe?g|gif|webp)/gi) ?? [];
  return matches.map(path => path.trim()).filter(path => IMAGE_EXTENSION.test(path));
}

function eventImagePaths(event: Record<string, unknown>): string[] {
  if (!event.item || typeof event.item !== "object") return [];
  const item = event.item as Record<string, unknown>;
  const values = [item.text, item.aggregated_output].filter((value): value is string => typeof value === "string");
  return values.flatMap(imagePaths);
}

function imagePreviewInstruction(prompt: string): string {
  if (!requestedImagePreview(prompt)) return prompt;
  return [
    prompt,
    "",
    "GPT Web Codex image handoff requirement:",
    "- Locate and verify the requested image, but do not claim that it is displayed or previewed in ChatGPT.",
    "- In the final answer, include the exact absolute path of every image the user should see.",
    "- The parent MCP runtime, not this Luna process, is responsible for rendering the image in ChatGPT.",
  ].join("\n");
}

export class LunaJobManager {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly prompts = new Map<string, string>();

  constructor(
    readonly store = new LunaStateStore(),
    private readonly spawnCodex: SpawnCodex = defaultSpawn,
    private readonly logDir = defaultStandaloneLogDir(store.path),
    private readonly codexExecutable?: string,
  ) {
    this.store.recoverInterruptedJobs();
    this.pruneLogs();
  }

  shutdown(): void {
    for (const child of this.active.values()) {
      try { terminateOwnedProcessTree(child); } catch {}
    }
    this.active.clear();
  }

  private pruneLogs(retentionDays = Number(process.env.WEBGPT_LOG_RETENTION_DAYS || 7)): void {
    if (!existsSync(this.logDir) || !Number.isFinite(retentionDays) || retentionDays < 0) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const entry of readdirSync(this.logDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(this.logDir, entry.name);
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    }
  }

  start(input: StartLunaJobInput): LunaJob {
    const webSessionId = validateSessionId(input.webSessionId);
    const cwd = input.cwd.trim();
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Workspace directory does not exist: ${cwd}`);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("prompt is required");
    const id = randomUUID();
    mkdirSync(this.logDir, { recursive: true });
    const job: LunaJob = {
      id,
      webSessionId,
      promptChars: prompt.length,
      wantsImagePreview: requestedImagePreview(prompt),
      imageArtifacts: [],
      cwd,
      model: input.model?.trim() || "gpt-5.6-luna",
      reasoning: input.reasoning ?? "low",
      fast: input.fast ?? true,
      sandbox: input.sandbox ?? "workspace-write",
      timeoutMs: input.timeoutMs ?? 15 * 60_000,
      status: "queued",
      createdAt: new Date().toISOString(),
      mutationSeen: false,
      eventCount: 0,
      attempts: 0,
      logPath: join(this.logDir, `${id}.jsonl`),
    };
    if (job.timeoutMs < 1_000 || job.timeoutMs > 24 * 60 * 60_000) throw new Error("timeout_ms must be between 1000 and 86400000");
    this.prompts.set(id, imagePreviewInstruction(prompt));
    this.store.putJob(job);
    const previous = this.tails.get(webSessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.run(id));
    const settled = next.finally(() => {
      if (this.tails.get(webSessionId) === settled) this.tails.delete(webSessionId);
    });
    this.tails.set(webSessionId, settled);
    return job;
  }

  get(jobId: string): LunaJob {
    const job = this.store.job(jobId);
    if (!job) throw new Error(`Unknown Luna job: ${jobId}`);
    return job;
  }

  cancel(jobId: string): LunaJob {
    const child = this.active.get(jobId);
    if (child && !child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => { try { terminateOwnedProcessTree(child); } catch {} }, 5_000).unref?.();
    }
    const job = this.get(jobId);
    if (job.status === "queued" || job.status === "running") {
      this.prompts.delete(jobId);
      return this.store.updateJob(jobId, { status: "cancelled", finishedAt: new Date().toISOString(), terminalEvent: "cancelled" });
    }
    return job;
  }

  private async run(jobId: string): Promise<void> {
    try {
      await this.runAttempt(jobId);
      const first = this.get(jobId);
      const transient = first.status === "failed"
        && !first.mutationSeen
        && (first.eventCount <= 2 || /ECONN|connection|stream|socket|network|transport|spawn/i.test(first.error ?? ""));
      if (!transient) return;
      this.store.updateJob(jobId, {
        status: "queued", error: undefined, finishedAt: undefined, terminalEvent: undefined,
        finalMessage: undefined, pid: undefined, exitCode: undefined,
      });
      await this.runAttempt(jobId);
    } finally {
      this.prompts.delete(jobId);
    }
  }

  private async runAttempt(jobId: string): Promise<void> {
    const queued = this.get(jobId);
    if (queued.status === "cancelled") return;
    const prompt = this.prompts.get(jobId);
    if (!prompt) {
      this.store.updateJob(jobId, {
        status: "failed", finishedAt: new Date().toISOString(), error: "Task prompt is unavailable after runtime restart",
      });
      return;
    }
    const binding = this.store.ensureBinding(queued.webSessionId);
    const invocation = buildCodexInvocation(queued, binding.lunaSessionId, this.codexExecutable);
    const child = this.spawnCodex(invocation.command, invocation.args, queued.cwd);
    this.active.set(jobId, child);
    this.store.updateJob(jobId, { status: "running", startedAt: new Date().toISOString(), pid: child.pid, attempts: queued.attempts + 1 });
    let terminalEvent: string | undefined;
    let finalMessage: string | undefined;
    let lunaSessionId = binding.lunaSessionId;
    let mutationSeen = false;
    let eventCount = 0;
    const imageArtifacts = new Set<string>(queued.imageArtifacts ?? []);
    let stderr = "";
    let timedOut = false;

    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        try { terminateOwnedProcessTree(child); }
        catch (error) { stderr = `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(); }
      }, 5_000);
      forceTimer.unref?.();
    }, queued.timeoutMs);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      appendFileSync(queued.logPath, `${line}\n`, "utf8");
      eventCount += 1;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "thread.started" && typeof event.thread_id === "string") {
          lunaSessionId = event.thread_id;
          this.store.bindLunaSession(queued.webSessionId, event.thread_id);
        }
        if (["turn.completed", "turn.failed", "error"].includes(String(event.type))) terminalEvent = String(event.type);
        finalMessage = eventText(event) ?? finalMessage;
        mutationSeen ||= eventMutates(event);
        for (const path of eventImagePaths(event)) {
          if (existsSync(path) && statSync(path).isFile()) imageArtifacts.add(path);
        }
      } catch {
        // Preserve malformed output in the JSONL log; the terminal process result remains authoritative.
      }
    });
    child.stderr.on("data", chunk => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
    child.stdin.end(`${prompt}\n`);

    const outcome = await new Promise<{ code: number | null; error?: Error }>(resolve => {
      child.once("error", error => resolve({ code: null, error }));
      child.once("close", code => resolve({ code }));
    });
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    lines.close();
    this.active.delete(jobId);
    const current = this.get(jobId);
    if (current.status === "cancelled") return;
    const status = timedOut ? "timed_out" : outcome.code === 0 && terminalEvent === "turn.completed" ? "completed" : "failed";
    this.store.updateJob(jobId, {
      status,
      finishedAt: new Date().toISOString(),
      exitCode: outcome.code,
      terminalEvent: timedOut ? "timeout" : terminalEvent,
      finalMessage,
      imageArtifacts: [...imageArtifacts],
      lunaSessionId,
      mutationSeen,
      eventCount,
      error: outcome.error?.message || (status === "failed" ? stderr.trim() || `Codex exited with ${outcome.code}` : undefined),
    });
  }
}
