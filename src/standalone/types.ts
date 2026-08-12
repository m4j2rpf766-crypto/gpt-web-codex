export type LunaSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type LunaReasoning = "low" | "medium" | "high" | "xhigh" | "max";
export type LunaJobStatus = "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface LunaSessionBinding {
  webSessionId: string;
  lunaSessionId?: string;
  workspacePath?: string;
  permissionMode?: LunaSandbox;
  model?: string;
  reasoning?: LunaReasoning;
  fast?: boolean;
  timeoutMs?: number;
  sessionPolicyVersion?: number;
  createdAt: string;
  updatedAt: string;
  lastJobId?: string;
}

export interface LunaJob {
  id: string;
  webSessionId: string;
  promptChars: number;
  cwd: string;
  model: string;
  reasoning: LunaReasoning;
  fast: boolean;
  sandbox: LunaSandbox;
  timeoutMs: number;
  status: LunaJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lunaSessionId?: string;
  pid?: number;
  exitCode?: number | null;
  terminalEvent?: string;
  finalMessage?: string;
  error?: string;
  mutationSeen: boolean;
  eventCount: number;
  attempts: number;
  logPath: string;
}

export interface LunaState {
  version: 1;
  sessions: Record<string, LunaSessionBinding>;
  jobs: Record<string, LunaJob>;
}

export interface StartLunaJobInput {
  webSessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoning?: LunaReasoning;
  fast?: boolean;
  sandbox?: LunaSandbox;
  timeoutMs?: number;
}
