import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexInvocation } from "../src/standalone/codex-command";
import { DirectToolService, resolveScopedPath } from "../src/standalone/direct-tools";
import { LunaJobManager } from "../src/standalone/luna-jobs";
import { LunaStateStore } from "../src/standalone/state-store";
import type { LunaJob } from "../src/standalone/types";

async function eventually(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await Bun.sleep(10);
  }
}

function sampleJob(root: string): LunaJob {
  return {
    id: "job", webSessionId: "web-session-123", promptChars: 5, cwd: root,
    model: "gpt-5.6-luna", reasoning: "high", fast: true, sandbox: "workspace-write",
    timeoutMs: 900_000, status: "queued", createdAt: new Date().toISOString(),
    mutationSeen: false, eventCount: 0, attempts: 0, logPath: join(root, "job.jsonl"),
  };
}

function completedCodexProcess(cwd: string, lunaSessionId?: string, delayMs = 10) {
  const script = [
    "process.stdin.resume();",
    ...(lunaSessionId ? [`console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(lunaSessionId)}}));`] : []),
    `setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log(JSON.stringify({type:'turn.completed'}));},${delayMs});`,
  ].join("");
  return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
}

async function inspectBindingThroughFreshMcp(statePath: string, webSessionId: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", statePath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webgpt-persistence-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({
      name: "codexluna_session",
      arguments: { web_session_id: webSessionId },
    });
    if (response.isError) throw new Error(JSON.stringify(response.structuredContent));
    return response.structuredContent as { binding: { webSessionId: string; lunaSessionId?: string } };
  } finally {
    await client.close();
  }
}

test("Codex invocation ignores routing config and reads prompt from stdin", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-command-"));
  try {
    const invocation = buildCodexInvocation(sampleJob(root), undefined, "C:\\codex.exe");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("--json");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain("do it");
    expect(invocation.args.join(" ")).not.toContain("openai_base_url");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same web session serializes jobs and resumes the durable Luna session", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-luna-"));
  const invocations: string[][] = [];
  let running = 0;
  let maximumRunning = 0;
  try {
    const store = new LunaStateStore(join(root, "state.json"));
    const manager = new LunaJobManager(store, (_command, args, cwd) => {
      invocations.push(args);
      const script = [
        "process.stdin.resume();",
        "console.log(JSON.stringify({type:'thread.started',thread_id:'luna-thread-1'}));",
        "setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'done'}}));console.log(JSON.stringify({type:'turn.completed'}));},40);",
      ].join("");
      const child = spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      child.once("close", () => { running -= 1; });
      return child;
    }, join(root, "logs"));
    const first = manager.start({ webSessionId: "conversation-123", prompt: "first", cwd: root });
    const second = manager.start({ webSessionId: "conversation-123", prompt: "second", cwd: root });
    await eventually(() => manager.get(second.id).status === "completed");
    expect(manager.get(first.id).status).toBe("completed");
    expect(maximumRunning).toBe(1);
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toContain("resume");
    expect(invocations[1]).toContain("luna-thread-1");
    expect(store.binding("conversation-123")?.lunaSessionId).toBe("luna-thread-1");
    expect(readFileSync(manager.get(first.id).logPath, "utf8")).toContain("turn.completed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recreated Luna manager resumes one web session while isolating another", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-restart-binding-"));
  const statePath = join(root, "state.json");
  const sessionA = "chatgpt:conversation-session-a";
  const sessionB = "chatgpt:conversation-session-b";
  try {
    const firstInvocations: string[][] = [];
    const firstManager = new LunaJobManager(
      new LunaStateStore(statePath),
      (_command, args, cwd) => {
        firstInvocations.push(args);
        return completedCodexProcess(cwd, "luna-thread-a");
      },
      join(root, "logs-first"),
    );
    const first = firstManager.start({ webSessionId: sessionA, prompt: "first", cwd: root });
    await eventually(() => firstManager.get(first.id).status === "completed");
    firstManager.shutdown();
    expect(firstInvocations[0]).not.toContain("resume");

    const restartedInvocations: string[][] = [];
    const restartedManager = new LunaJobManager(
      new LunaStateStore(statePath),
      (_command, args, cwd) => {
        restartedInvocations.push(args);
        return completedCodexProcess(cwd, args.includes("resume") ? undefined : "luna-thread-b");
      },
      join(root, "logs-restarted"),
    );
    const resumed = restartedManager.start({ webSessionId: sessionA, prompt: "resume A", cwd: root });
    await eventually(() => restartedManager.get(resumed.id).status === "completed");
    const separate = restartedManager.start({ webSessionId: sessionB, prompt: "start B", cwd: root });
    await eventually(() => restartedManager.get(separate.id).status === "completed");
    restartedManager.shutdown();

    expect(restartedInvocations[0]).toContain("resume");
    expect(restartedInvocations[0]).toContain("luna-thread-a");
    expect(restartedInvocations[1]).not.toContain("resume");
    const reloaded = new LunaStateStore(statePath);
    expect(reloaded.binding(sessionA)?.lunaSessionId).toBe("luna-thread-a");
    expect(reloaded.binding(sessionB)?.lunaSessionId).toBe("luna-thread-b");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two fresh MCP processes recover the same persisted web-to-Luna binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-restart-"));
  const statePath = join(root, "state.json");
  const webSessionId = "chatgpt:conversation-mcp-restart";
  try {
    const store = new LunaStateStore(statePath);
    store.bindLunaSession(webSessionId, "luna-thread-persisted");
    const firstProcess = await inspectBindingThroughFreshMcp(statePath, webSessionId);
    const secondProcess = await inspectBindingThroughFreshMcp(statePath, webSessionId);
    expect(firstProcess.binding).toMatchObject({ webSessionId, lunaSessionId: "luna-thread-persisted" });
    expect(secondProcess.binding).toEqual(firstProcess.binding);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed, timed-out, and interrupted jobs preserve their Luna binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-binding-failures-"));
  const statePath = join(root, "state.json");
  const webSessionId = "chatgpt:conversation-failure";
  try {
    const store = new LunaStateStore(statePath);
    store.bindLunaSession(webSessionId, "luna-thread-survives");
    const failing = new LunaJobManager(store, (_command, _args, cwd) => {
      const script = "process.stdin.resume();process.stderr.write('synthetic failure');process.exitCode=1;";
      return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    }, join(root, "logs-failed"));
    const failedJob = failing.start({ webSessionId, prompt: "fail", cwd: root });
    await eventually(() => failing.get(failedJob.id).status === "failed");
    expect(store.binding(webSessionId)?.lunaSessionId).toBe("luna-thread-survives");
    failing.shutdown();

    const timingOut = new LunaJobManager(new LunaStateStore(statePath), (_command, _args, cwd) => {
      const script = "process.stdin.resume();setInterval(()=>{},1000);";
      return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    }, join(root, "logs-timeout"));
    const timedOutJob = timingOut.start({ webSessionId, prompt: "timeout", cwd: root, timeoutMs: 1_000 });
    await eventually(() => timingOut.get(timedOutJob.id).status === "timed_out", 5_000);
    expect(timingOut.store.binding(webSessionId)?.lunaSessionId).toBe("luna-thread-survives");
    timingOut.shutdown();

    const interruptedStore = new LunaStateStore(statePath);
    const interrupted = { ...sampleJob(root), id: "interrupted-job", webSessionId, status: "running" as const };
    interruptedStore.putJob(interrupted);
    const recovered = new LunaJobManager(interruptedStore, undefined, join(root, "logs-recovered"));
    expect(recovered.get(interrupted.id).status).toBe("failed");
    expect(recovered.get(interrupted.id).terminalEvent).toBe("runtime_restarted");
    expect(recovered.store.binding(webSessionId)?.lunaSessionId).toBe("luna-thread-survives");
    recovered.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct files enforce the disclosed workspace and permission mode", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-files-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const tools = new DirectToolService();
    tools.write("hello.txt", "hello", workspace, "workspace-write");
    expect(tools.read("hello.txt", workspace, "workspace-write").text).toBe("hello");
    expect(tools.search("hell", ".", workspace, "workspace-write").matches[0]?.line).toBe(1);
    expect(() => tools.write("blocked.txt", "x", workspace, "read-only")).toThrow("read-only");
    expect(() => resolveScopedPath("..\\outside.txt", workspace, "workspace-write")).toThrow("outside");
    expect(resolveScopedPath("..\\outside.txt", workspace, "danger-full-access")).toBe(join(root, "outside.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone MCP exposes Luna and direct tools without a turn broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", join(root, "state.json")],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webgpt-standalone-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual([
      "codexluna_cancel", "codexluna_session", "codexluna_start", "codexluna_status",
      "file_list", "file_read", "file_search", "file_write", "terminal_cancel", "terminal_start", "terminal_status",
    ]);
    const binding = await client.callTool({
      name: "codexluna_session",
      arguments: { web_session_id: "conversation-standalone-123" },
    });
    expect(binding.isError).not.toBe(true);
    expect(JSON.stringify(binding.structuredContent)).toContain("conversation-standalone-123");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
