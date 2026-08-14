import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { buildCodexInvocation } from "../src/standalone/codex-command";
import { DirectToolService, resolveScopedPath } from "../src/standalone/direct-tools";
import {
  IMAGE_PREVIEW_MIME_TYPE,
  IMAGE_PREVIEW_RESOURCE_URI,
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS,
} from "../src/standalone/image-preview";
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
    return response.structuredContent as { binding: { web_session_id: string; luna_session_id: string | null } };
  } finally {
    await client.close();
  }
}

test("Codex invocation ignores routing config and reads prompt from stdin", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-command-"));
  try {
    const invocation = buildCodexInvocation(sampleJob(root), undefined, "C:\\codex.exe", "win32");
    expect(invocation.args).toContain("--ignore-user-config");
    expect(invocation.args).toContain("--json");
    expect(invocation.args.at(-1)).toBe("-");
    expect(invocation.args.join(" ")).not.toContain("do it");
    expect(invocation.args.join(" ")).not.toContain("openai_base_url");
    expect(invocation.args).toContain("approval_policy=\"never\"");
    expect(invocation.args).toContain("windows.sandbox=\"unelevated\"");
    expect(invocation.args).toContain("sandbox_workspace_write.network_access=true");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex invocation maps all three standalone permission modes explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-permissions-"));
  try {
    const base = sampleJob(root);
    const readonly = buildCodexInvocation({ ...base, sandbox: "read-only" }, undefined, "C:\\codex.exe", "win32");
    expect(readonly.args).toContain("read-only");
    expect(readonly.args).toContain("windows.sandbox=\"unelevated\"");
    expect(readonly.args).not.toContain("sandbox_workspace_write.network_access=true");

    const writable = buildCodexInvocation(base, undefined, "C:\\codex.exe", "win32");
    expect(writable.args).toContain("workspace-write");
    expect(writable.args).toContain("sandbox_workspace_write.network_access=true");

    const full = buildCodexInvocation({ ...base, sandbox: "danger-full-access" }, undefined, "C:\\codex.exe", "win32");
    expect(full.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(full.args).not.toContain("--sandbox");
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
    }, join(root, "logs"), process.execPath);
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

test("image-preview Luna tasks persist verified local image artifacts without claiming UI rendering", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-luna-image-artifact-"));
  const imagePath = join(root, "preview image.png");
  writeFileSync(imagePath, Buffer.from("image"));
  try {
    const manager = new LunaJobManager(new LunaStateStore(join(root, "state.json")), (_command, _args, cwd) => {
      const events = [
        { type: "thread.started", thread_id: "luna-image-thread" },
        { type: "item.completed", item: { type: "command_execution", aggregated_output: `FullName : ${imagePath}` } },
        { type: "item.completed", item: { type: "agent_message", text: `Found ${imagePath}` } },
        { type: "turn.completed" },
      ];
      const script = `process.stdin.resume();${events.map(event => `console.log(${JSON.stringify(JSON.stringify(event))});`).join("")}process.exitCode=0;`;
      return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    }, join(root, "logs"), process.execPath);
    const job = manager.start({ webSessionId: "image-session-123", prompt: "显示最新的图片", cwd: root });
    await eventually(() => manager.get(job.id).status === "completed");
    expect(manager.get(job.id).wantsImagePreview).toBe(true);
    expect(manager.get(job.id).imageArtifacts).toEqual([imagePath]);
    expect(manager.get(job.id).finalMessage).toContain(imagePath);
    expect(manager.get(job.id).finalMessage).not.toContain("显示在上方");
    manager.shutdown();
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
      process.execPath,
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
      process.execPath,
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
    expect(firstProcess.binding).toMatchObject({ web_session_id: webSessionId, luna_session_id: "luna-thread-persisted" });
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
    }, join(root, "logs-failed"), process.execPath);
    const failedJob = failing.start({ webSessionId, prompt: "fail", cwd: root });
    await eventually(() => failing.get(failedJob.id).status === "failed");
    expect(store.binding(webSessionId)?.lunaSessionId).toBe("luna-thread-survives");
    failing.shutdown();

    const timingOut = new LunaJobManager(new LunaStateStore(statePath), (_command, _args, cwd) => {
      const script = "process.stdin.resume();setInterval(()=>{},1000);";
      return spawn(process.execPath, ["-e", script], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    }, join(root, "logs-timeout"), process.execPath);
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
    const textFile = tools.read("hello.txt", workspace, "workspace-write");
    expect("text" in textFile ? textFile.text : null).toBe("hello");
    expect(tools.search("hell", ".", workspace, "workspace-write").matches[0]?.line).toBe(1);
    expect(() => tools.write("blocked.txt", "x", workspace, "read-only")).toThrow("read-only");
    const outsidePath = join("..", "outside.txt");
    expect(() => resolveScopedPath(outsidePath, workspace, "workspace-write")).toThrow("outside");
    expect(resolveScopedPath(outsidePath, workspace, "danger-full-access")).toBe(join(root, "outside.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct file reads preserve supported images as bounded native content", () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-image-read-"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  try {
    writeFileSync(join(root, "pixel.png"), image);
    const tools = new DirectToolService();
    expect(tools.read("pixel.png", root, "read-only")).toEqual({
      path: join(root, "pixel.png"), mimeType: "image/png", data: image.toString("base64"), bytes: image.length,
    });
    expect(() => tools.read("pixel.png", root, "read-only", 200_000, image.length - 1)).toThrow("transfer limit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model image transfers compact high-resolution files without modifying the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-image-optimize-"));
  const imagePath = join(root, "large.png");
  try {
    await sharp({ create: { width: 3_000, height: 2_000, channels: 4, background: "#2f6feb" } }).png().toFile(imagePath);
    const source = readFileSync(imagePath);
    const value = await new DirectToolService().readForTransfer("large.png", root, "read-only");
    expect("data" in value).toBe(true);
    if (!("data" in value)) throw new Error("expected an image transfer");
    expect(value).toMatchObject({
      path: imagePath, mimeType: "image/webp", optimized: true,
      sourceBytes: source.length, sourceMimeType: "image/png", width: 1_600,
    });
    expect(value.height).toBeLessThanOrEqual(1_600);
    expect(value.bytes).toBeLessThanOrEqual(1_500_000);
    expect(readFileSync(imagePath)).toEqual(source);
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
    expect(client.getInstructions()).toContain("Use codexluna_init before the first codexluna_start");
    expect(client.getInstructions()).toContain("不得主动把本对话中的内容");
    expect(client.getInstructions()).toContain("无需要求用户回复确认口令");
    expect(client.getInstructions()).toContain("Never claim that an image is displayed");
    const listedTools = (await client.listTools()).tools;
    const names = listedTools.map(tool => tool.name).sort();
    expect(names).toEqual([
      "codexluna_cancel", "codexluna_init", "codexluna_session", "codexluna_start", "codexluna_status",
      "file_image_preview", "file_image_preview_restore", "file_list", "file_read", "file_search", "file_write",
      "terminal_cancel", "terminal_start", "terminal_status",
    ]);
    expect(listedTools.every(tool => tool.outputSchema && typeof tool.outputSchema === "object")).toBe(true);
    expect(listedTools.every(tool => Array.isArray(tool._meta?.securitySchemes))).toBe(true);
    const initialized = await client.callTool({
      name: "codexluna_init",
      arguments: { workspace_path: root },
    });
    expect(initialized.isError).not.toBe(true);
    const init = initialized.structuredContent as {
      web_session_id: string;
      session_policy: Record<string, unknown>;
      session_boundary_notice: string;
    };
    expect(init.web_session_id).toMatch(/^webgpt:[0-9a-f-]{36}$/);
    expect(init.session_policy).toMatchObject({
      scope: "current_web_session_only",
      allow_long_term_memory_write: false,
      allow_long_term_memory_update: false,
      allow_cross_chat_migration: false,
      allow_same_session_persistence: true,
      requires_acknowledgement: false,
    });
    expect(init.session_boundary_notice).toContain("不得主动把本对话中的内容");
    expect(init.session_boundary_notice).toContain("不会修改或关闭 ChatGPT 账户");
    const metadataInitialized = await client.callTool({
      name: "codexluna_init",
      arguments: { workspace_path: root },
      _meta: { "openai/session": "stable-chatgpt-conversation" },
    });
    const metadataInit = metadataInitialized.structuredContent as { web_session_id: string };
    expect(metadataInit.web_session_id).toMatch(/^chatgpt:[a-f0-9]{64}$/);
    const metadataBinding = await client.callTool({
      name: "codexluna_session",
      arguments: {},
      _meta: { "openai/session": "stable-chatgpt-conversation" },
    });
    expect(metadataBinding.structuredContent).toMatchObject({
      binding: { web_session_id: metadataInit.web_session_id, workspace_path: root },
    });
    const initializedState = new LunaStateStore(join(root, "state.json")).binding(init.web_session_id);
    expect(initializedState).toMatchObject({
      workspacePath: root,
      permissionMode: "workspace-write",
      model: "gpt-5.6-luna",
      reasoning: "low",
      fast: true,
      timeoutMs: 900_000,
      sessionPolicyVersion: 1,
    });
    const binding = await client.callTool({
      name: "codexluna_session",
      arguments: { web_session_id: "conversation-standalone-123" },
    });
    expect(binding.isError).not.toBe(true);
    expect(binding.structuredContent).toMatchObject({ binding: null });
    const uninitializedStart = await client.callTool({
      name: "codexluna_start",
      arguments: {
        web_session_id: "uninitialized-conversation-123",
        prompt: "inspect only",
        workspace_path: root,
      },
    });
    expect(uninitializedStart.isError).toBe(true);
    expect(JSON.stringify(uninitializedStart.content)).toContain("codexluna_init must initialize");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completed Luna image status returns native image content and inline preview metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-luna-image-status-"));
  const statePath = join(root, "state.json");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const imagePath = join(root, "luna-preview.png");
  writeFileSync(imagePath, image);
  const storedJob = { ...sampleJob(root), id: "44444444-4444-4444-8444-444444444444", status: "completed" as const,
    wantsImagePreview: true, imageArtifacts: [imagePath], finalMessage: `Found ${imagePath}`, terminalEvent: "turn.completed" };
  const store = new LunaStateStore(statePath);
  store.initializeBinding(storedJob.webSessionId, {
    workspacePath: root, permissionMode: "read-only", model: "gpt-5.6-luna", reasoning: "high",
    fast: true, timeoutMs: 900_000, sessionPolicyVersion: 1,
  });
  store.putJob(storedJob);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", statePath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webgpt-luna-image-status-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === "codexluna_status")?._meta?.["openai/outputTemplate"]).toBe(IMAGE_PREVIEW_RESOURCE_URI);
    const output = await client.callTool({ name: "codexluna_status", arguments: { job_id: storedJob.id } });
    expect(output.isError).not.toBe(true);
    expect(output.structuredContent).toMatchObject({
      status: "completed", image_artifacts: [imagePath], image_preview_rendered: true, image_preview_error: null,
    });
    const previewId = (output.structuredContent as { image_preview_id: string }).image_preview_id;
    expect(previewId).toMatch(/^[0-9a-f-]{36}$/);
    const content = output.content as Array<{ type: string; data?: string }>;
    expect(content.some(item => item.type === "image" && item.data === image.toString("base64"))).toBe(true);
    expect(output._meta?.webgpt_image_preview).toEqual({
      preview_id: previewId,
      name: "luna-preview.png", mime_type: "image/png", bytes: image.length, width: 1, height: 1,
      data_url: `data:image/png;base64,${image.toString("base64")}`,
    });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone MCP file_read transmits an image content block without base64 duplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-image-"));
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const statePath = join(root, "state.json");
  writeFileSync(join(root, "pixel.png"), image);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", statePath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webgpt-image-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.find(tool => tool.name === "file_read")?._meta?.["openai/outputTemplate"]).toBeUndefined();
    expect(tools.tools.find(tool => tool.name === "file_read")?._meta?.["ui/resourceUri"]).toBeUndefined();
    expect(tools.tools.find(tool => tool.name === "file_image_preview")?._meta?.["openai/outputTemplate"]).toBe(IMAGE_PREVIEW_RESOURCE_URI);
    expect(tools.tools.find(tool => tool.name === "file_image_preview")?._meta?.ui).toEqual({ resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] });
    expect(tools.tools.find(tool => tool.name === "file_image_preview_restore")?._meta?.ui).toEqual({ visibility: ["app"] });
    expect(tools.tools.find(tool => tool.name === "file_image_preview_restore")?._meta?.["openai/widgetAccessible"]).toBe(true);
    expect(tools.tools.find(tool => tool.name === "file_image_preview_restore")?._meta?.["openai/visibility"]).toBe("private");
    const resources = await client.listResources();
    expect(resources.resources.some(resource => resource.uri === IMAGE_PREVIEW_RESOURCE_URI)).toBe(true);
    for (const legacyUri of LEGACY_IMAGE_PREVIEW_RESOURCE_URIS) {
      expect(resources.resources.some(resource => resource.uri === legacyUri)).toBe(true);
    }
    const preview = await client.readResource({ uri: IMAGE_PREVIEW_RESOURCE_URI });
    expect(preview.contents[0]?.mimeType).toBe(IMAGE_PREVIEW_MIME_TYPE);
    const previewContent = preview.contents[0];
    const previewHtml = previewContent && "text" in previewContent ? previewContent.text : "";
    expect(previewHtml).toContain("webgpt_image_preview");
    expect(previewHtml).toContain("widgetState");
    expect(previewHtml).toContain("setWidgetState");
    expect(previewHtml).toContain("file_image_preview_restore");
    expect(previewHtml).toContain('request("tools/call"');
    for (const legacyUri of LEGACY_IMAGE_PREVIEW_RESOURCE_URIS) {
      const legacyPreview = await client.readResource({ uri: legacyUri });
      expect(legacyPreview.contents[0]?.mimeType).toBe(IMAGE_PREVIEW_MIME_TYPE);
      const legacyContent = legacyPreview.contents[0];
      expect(legacyContent && "text" in legacyContent ? legacyContent.text : "").toBe(previewHtml);
    }
    const output = await client.callTool({
      name: "file_read",
      arguments: { path: "pixel.png", workspace_path: root, permission_mode: "read-only" },
    });
    expect(output.content).toEqual([
      { type: "text", text: "Image metadata is available in structuredContent; the image follows as native MCP content." },
      { type: "image", data: image.toString("base64"), mimeType: "image/png" },
    ]);
    expect(JSON.stringify(output.structuredContent)).not.toContain(image.toString("base64"));
    expect(output._meta?.webgpt_image_preview).toBeUndefined();
    const rendered = await client.callTool({
      name: "file_image_preview",
      arguments: { path: "pixel.png", workspace_path: root, permission_mode: "read-only" },
    });
    expect(rendered.structuredContent).toMatchObject({
      path: join(root, "pixel.png"), mime_type: "image/png", bytes: image.length, width: 1, height: 1,
    });
    const previewId = (rendered.structuredContent as { preview_id: string }).preview_id;
    expect(previewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rendered._meta?.webgpt_image_preview).toEqual({
      preview_id: previewId,
      name: "pixel.png",
      mime_type: "image/png",
      bytes: image.length,
      width: 1,
      height: 1,
      data_url: `data:image/png;base64,${image.toString("base64")}`,
    });
    const restored = await client.callTool({
      name: "file_image_preview_restore",
      arguments: { preview_id: previewId },
    });
    expect(restored.structuredContent).toMatchObject({ preview_id: previewId, name: "pixel.png", mime_type: "image/png" });
    expect(JSON.stringify(restored.structuredContent)).not.toContain(image.toString("base64"));
    expect(restored._meta?.webgpt_image_preview).toMatchObject({
      preview_id: previewId,
      data_url: `data:image/png;base64,${image.toString("base64")}`,
    });
    writeFileSync(join(root, "plain.txt"), "not an image");
    const rejected = await client.callTool({
      name: "file_image_preview",
      arguments: { path: "plain.txt", workspace_path: root, permission_mode: "read-only" },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("not a supported image");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("image preview restore survives an MCP process restart without the source file", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-image-restore-"));
  const statePath = join(root, "state.json");
  const imagePath = join(root, "persistent-preview.png");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  writeFileSync(imagePath, image);
  let firstClient: Client | undefined;
  let secondClient: Client | undefined;
  try {
    firstClient = new Client({ name: "webgpt-image-cache-writer", version: "1.0.0" });
    await firstClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--state-path", statePath],
      cwd: process.cwd(),
      stderr: "pipe",
    }));
    const rendered = await firstClient.callTool({
      name: "file_image_preview",
      arguments: { path: imagePath, workspace_path: root, permission_mode: "read-only" },
    });
    const previewId = (rendered.structuredContent as { preview_id: string }).preview_id;
    await firstClient.close();
    firstClient = undefined;
    rmSync(imagePath, { force: true });

    secondClient = new Client({ name: "webgpt-image-cache-reader", version: "1.0.0" });
    await secondClient.connect(new StdioClientTransport({
      command: process.execPath,
      args: ["src/cli.ts", "mcp", "--state-path", statePath],
      cwd: process.cwd(),
      stderr: "pipe",
    }));
    const restored = await secondClient.callTool({
      name: "file_image_preview_restore",
      arguments: { preview_id: previewId },
    });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent).toMatchObject({
      preview_id: previewId, name: "persistent-preview.png", mime_type: "image/png", bytes: image.length,
    });
    expect(restored._meta?.webgpt_image_preview).toMatchObject({
      preview_id: previewId,
      data_url: `data:image/png;base64,${image.toString("base64")}`,
    });
  } finally {
    await firstClient?.close();
    await secondClient?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured tool results are not duplicated into text content", async () => {
  const root = mkdtempSync(join(tmpdir(), "webgpt-mcp-structured-only-"));
  const statePath = join(root, "state.json");
  const marker = "STRUCTURED_ONLY_MARKER_".repeat(2_000);
  writeFileSync(join(root, "large.txt"), marker);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/cli.ts", "mcp", "--state-path", statePath],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  const client = new Client({ name: "webgpt-structured-only-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const output = await client.callTool({
      name: "file_read",
      arguments: { path: "large.txt", workspace_path: root, permission_mode: "read-only" },
    });
    expect(output.structuredContent).toMatchObject({ path: join(root, "large.txt"), text: marker, truncated: false });
    expect(JSON.stringify(output.content)).not.toContain("STRUCTURED_ONLY_MARKER_");
    expect(JSON.stringify(output.content).length).toBeLessThan(160);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
