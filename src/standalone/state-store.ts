import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";
import type { LunaJob, LunaReasoning, LunaSandbox, LunaSessionBinding, LunaState } from "./types";

export interface InitializeSessionBindingInput {
  workspacePath: string;
  permissionMode: LunaSandbox;
  model: string;
  reasoning: LunaReasoning;
  fast: boolean;
  timeoutMs: number;
  sessionPolicyVersion: number;
}

export function defaultStandaloneStatePath(home = getConfigDir()): string {
  return join(home, "standalone", "state.json");
}

export function defaultStandaloneLogDir(statePath = defaultStandaloneStatePath()): string {
  return join(dirname(statePath), "logs");
}

function emptyState(): LunaState {
  return { version: 1, sessions: {}, jobs: {} };
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
}

export class LunaStateStore {
  readonly path: string;
  private state: LunaState;

  constructor(path = defaultStandaloneStatePath()) {
    this.path = resolve(path);
    this.state = this.load();
  }

  private load(): LunaState {
    if (!existsSync(this.path)) return emptyState();
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    assertRecord(parsed, "standalone state");
    if (parsed.version !== 1) throw new Error(`Unsupported standalone state version in ${this.path}`);
    assertRecord(parsed.sessions, "standalone sessions");
    assertRecord(parsed.jobs, "standalone jobs");
    return parsed as unknown as LunaState;
  }

  private save(): void {
    atomicWriteFile(this.path, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  binding(webSessionId: string): LunaSessionBinding | undefined {
    return this.state.sessions[webSessionId];
  }

  ensureBinding(webSessionId: string): LunaSessionBinding {
    const existing = this.binding(webSessionId);
    if (existing) return existing;
    const now = new Date().toISOString();
    const binding = { webSessionId, createdAt: now, updatedAt: now };
    this.state.sessions[webSessionId] = binding;
    this.save();
    return binding;
  }

  initializeBinding(webSessionId: string, input: InitializeSessionBindingInput): LunaSessionBinding {
    const binding = this.ensureBinding(webSessionId);
    Object.assign(binding, input, { updatedAt: new Date().toISOString() });
    this.save();
    return binding;
  }

  bindLunaSession(webSessionId: string, lunaSessionId: string): void {
    const binding = this.ensureBinding(webSessionId);
    binding.lunaSessionId = lunaSessionId;
    binding.updatedAt = new Date().toISOString();
    this.save();
  }

  putJob(job: LunaJob): void {
    this.state.jobs[job.id] = job;
    const binding = this.ensureBinding(job.webSessionId);
    binding.lastJobId = job.id;
    binding.updatedAt = new Date().toISOString();
    this.save();
  }

  updateJob(jobId: string, patch: Partial<LunaJob>): LunaJob {
    const current = this.state.jobs[jobId];
    if (!current) throw new Error(`Unknown Luna job: ${jobId}`);
    const updated = { ...current, ...patch };
    this.state.jobs[jobId] = updated;
    this.save();
    return updated;
  }

  job(jobId: string): LunaJob | undefined {
    return this.state.jobs[jobId];
  }

  recoverInterruptedJobs(): number {
    let changed = 0;
    const now = new Date().toISOString();
    for (const job of Object.values(this.state.jobs)) {
      if (job.status !== "queued" && job.status !== "running") continue;
      Object.assign(job, {
        status: "failed",
        finishedAt: now,
        terminalEvent: "runtime_restarted",
        error: "The standalone MCP runtime restarted before this task completed; its Luna session binding was preserved",
      });
      changed += 1;
    }
    if (changed > 0) this.save();
    return changed;
  }

  snapshot(): LunaState {
    return structuredClone(this.state);
  }
}
