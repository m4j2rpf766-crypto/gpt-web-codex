import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { DirectToolService } from "../../standalone/direct-tools";
import { IMAGE_PREVIEW_HTML, IMAGE_PREVIEW_MIME_TYPE, IMAGE_PREVIEW_RESOURCE_URI } from "../../standalone/image-preview";
import { LunaJobManager } from "../../standalone/luna-jobs";
import {
  COMPACT_SESSION_POLICY,
  MCP_SERVER_INSTRUCTIONS,
  SESSION_BOUNDARY_NOTICE,
  SESSION_POLICY,
  SESSION_POLICY_VERSION,
} from "../../standalone/session-policy";
import { LunaStateStore } from "../../standalone/state-store";

const sessionId = z.string().min(8).max(256);
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const reasoning = z.enum(["low", "medium", "high", "xhigh", "max"]);

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function lunaResult(value: Record<string, unknown>, isError = false) {
  return result({ ...value, session_policy: COMPACT_SESSION_POLICY }, isError);
}

function fileReadResult(value: ReturnType<DirectToolService["read"]>) {
  if (!("data" in value)) return result({ ...value });
  const metadata = { path: value.path, mime_type: value.mimeType, bytes: value.bytes };
  const name = value.path.replaceAll("\\", "/").split("/").at(-1) || "image";
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(metadata) },
      { type: "image" as const, data: value.data, mimeType: value.mimeType },
    ],
    structuredContent: metadata,
    _meta: {
      webgpt_image_preview: {
        name,
        mime_type: value.mimeType,
        bytes: value.bytes,
        data_url: `data:${value.mimeType};base64,${value.data}`,
      },
    },
  };
}

function fileImagePreviewResult(value: ReturnType<DirectToolService["read"]>) {
  if (!("data" in value)) return result({ ...value }, true);
  const metadata = { path: value.path, mime_type: value.mimeType, bytes: value.bytes };
  const name = value.path.replaceAll("\\", "/").split("/").at(-1) || "image";
  return {
    content: [{ type: "text" as const, text: `Displaying local image preview: ${name}` }],
    structuredContent: metadata,
    _meta: {
      webgpt_image_preview: {
        name,
        mime_type: value.mimeType,
        bytes: value.bytes,
        data_url: `data:${value.mimeType};base64,${value.data}`,
      },
    },
  };
}

export async function runChatGptMcpServer(options: { statePath?: string } = {}): Promise<void> {
  const jobs = new LunaJobManager(new LunaStateStore(options.statePath));
  const direct = new DirectToolService();
  const server = new McpServer(
    { name: "webgpt-luna", version: "0.3.0" },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const shutdown = () => {
    jobs.shutdown();
    direct.shutdown();
    setTimeout(() => process.exit(0), 0).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.registerResource("webgpt-image-preview", IMAGE_PREVIEW_RESOURCE_URI, {
    title: "WebGPT local image preview",
    description: "Inline preview card for a local image returned by file_read.",
    mimeType: IMAGE_PREVIEW_MIME_TYPE,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Displays the local image returned by file_read directly in the conversation.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  }, async () => ({
    contents: [{
      uri: IMAGE_PREVIEW_RESOURCE_URI,
      mimeType: IMAGE_PREVIEW_MIME_TYPE,
      text: IMAGE_PREVIEW_HTML,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Displays the local image returned by file_read directly in the conversation.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      },
    }],
  }));

  server.registerTool("codexluna_init", {
    title: "Initialize this ChatGPT conversation",
    description: "Initialize or restore the GPT Web Codex binding for the current ChatGPT conversation before its first Luna task. Omit web_session_id to create a new conversation-scoped ID. Reuse a returned ID only in the same ChatGPT conversation. Return the complete session-memory boundary and visibly summarize it without asking the user for an ACK.",
    inputSchema: {
      web_session_id: sessionId.optional(),
      workspace_path: z.string().min(1).max(16_384),
      model: z.string().min(1).max(200).default("gpt-5.6-luna"),
      reasoning_effort: reasoning.default("high"),
      fast: z.boolean().default(true),
      permission_mode: sandbox.default("workspace-write"),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).default(900_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async input => {
    const webSessionId = input.web_session_id?.trim() || `webgpt:${randomUUID()}`;
    const workspacePath = resolve(input.workspace_path.trim());
    if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
      throw new Error(`Workspace directory does not exist: ${workspacePath}`);
    }
    const binding = jobs.store.initializeBinding(webSessionId, {
      workspacePath,
      permissionMode: input.permission_mode,
      model: input.model,
      reasoning: input.reasoning_effort,
      fast: input.fast,
      timeoutMs: input.timeout_ms,
      sessionPolicyVersion: SESSION_POLICY_VERSION,
    });
    return result({
      initialized: true,
      web_session_id: webSessionId,
      workspace_path: binding.workspacePath,
      permission_mode: binding.permissionMode,
      model: binding.model,
      reasoning_effort: binding.reasoning,
      fast: binding.fast,
      timeout_ms: binding.timeoutMs,
      luna_session_id: binding.lunaSessionId ?? null,
      session_policy: SESSION_POLICY,
      session_boundary_notice: SESSION_BOUNDARY_NOTICE,
    });
  });

  server.registerTool("codexluna_start", {
    title: "Start Luna execution",
    description: "Start an asynchronous Codex Luna task after codexluna_init. Tasks in one web_session_id run serially and reuse its Luna session. Reuse that ID only in the same ChatGPT conversation. Omitted execution settings inherit the initialized binding.",
    inputSchema: {
      web_session_id: sessionId,
      prompt: z.string().min(1).max(1_000_000),
      workspace_path: z.string().min(1).max(16_384).optional(),
      model: z.string().min(1).max(200).optional(),
      reasoning_effort: reasoning.optional(),
      fast: z.boolean().optional(),
      permission_mode: sandbox.optional(),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => {
    const binding = jobs.store.binding(input.web_session_id);
    const workspacePath = input.workspace_path ?? binding?.workspacePath;
    if (!workspacePath) throw new Error("codexluna_init must be called before codexluna_start, or workspace_path must be provided");
    const job = jobs.start({
      webSessionId: input.web_session_id,
      prompt: input.prompt,
      cwd: workspacePath,
      model: input.model ?? binding?.model,
      reasoning: input.reasoning_effort ?? binding?.reasoning,
      fast: input.fast ?? binding?.fast,
      sandbox: input.permission_mode ?? binding?.permissionMode,
      timeoutMs: input.timeout_ms ?? binding?.timeoutMs,
    });
    return lunaResult({ web_session_id: job.webSessionId, job_id: job.id, status: job.status, workspace_path: job.cwd, permission_mode: job.sandbox, timeout_ms: job.timeoutMs });
  });

  server.registerTool("codexluna_status", {
    title: "Get Luna execution status",
    description: "Poll an asynchronous Luna task. Completed results are compact; full JSONL remains in the local log.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const job = jobs.get(job_id);
    return lunaResult({
      web_session_id: job.webSessionId,
      job_id: job.id, status: job.status, luna_session_id: job.lunaSessionId ?? null,
      workspace_path: job.cwd, terminal_event: job.terminalEvent ?? null, final_message: job.finalMessage ?? null,
      error: job.error ?? null, mutation_seen: job.mutationSeen, event_count: job.eventCount,
    });
  });

  server.registerTool("codexluna_cancel", {
    title: "Cancel Luna execution",
    description: "Cancel only the owned Luna process for a queued or running task; the conversation binding is preserved.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const job = jobs.cancel(job_id);
    return lunaResult({ ...job, web_session_id: job.webSessionId });
  });

  server.registerTool("codexluna_session", {
    title: "Inspect Luna session binding",
    description: "Inspect the durable Luna session bound to a ChatGPT web conversation.",
    inputSchema: { web_session_id: sessionId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ web_session_id }) => lunaResult({ binding: jobs.store.ensureBinding(web_session_id) }));

  server.registerTool("file_read", {
    title: "Read a local text file or image",
    description: "Read text directly or transfer a PNG, JPEG, GIF, or WebP image as a native MCP image content block so ChatGPT can inspect it. To visibly render an image in the conversation, call file_image_preview with the same path and workspace after inspection. The resolved path and disclosed workspace are checked unless full access is selected. Images default to a 10 MB transfer limit and never appear as base64 text.",
    inputSchema: { path: z.string().min(1), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_chars: z.number().int().min(1).max(1_000_000).default(200_000), max_image_bytes: z.number().int().min(1).max(20_000_000).default(10_000_000) },
    outputSchema: {
      path: z.string(),
      mime_type: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      text: z.string().optional(),
      truncated: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
      "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/toolInvocation/invoking": "正在读取本地文件",
      "openai/toolInvocation/invoked": "本地文件读取完成",
    },
  }, async input => fileReadResult(direct.read(input.path, input.workspace_path, input.permission_mode, input.max_chars, input.max_image_bytes)));

  server.registerTool("file_image_preview", {
    title: "Display a local image inline",
    description: "Render a PNG, JPEG, GIF, or WebP file as a visible inline image card in the ChatGPT conversation. Use this presentation tool whenever the user asks to see or preview a local image. The resolved path and disclosed workspace are checked unless full access is selected.",
    inputSchema: { path: z.string().min(1), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_image_bytes: z.number().int().min(1).max(20_000_000).default(10_000_000) },
    outputSchema: { path: z.string(), mime_type: z.string(), bytes: z.number().int().nonnegative() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
      "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/toolInvocation/invoking": "正在准备图片预览",
      "openai/toolInvocation/invoked": "图片预览已就绪",
    },
  }, async input => fileImagePreviewResult(direct.read(input.path, input.workspace_path, input.permission_mode, 1, input.max_image_bytes)));

  server.registerTool("file_list", {
    title: "List a local directory",
    description: "List direct children of a directory in the disclosed workspace.",
    inputSchema: { path: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => result(direct.list(input.path, input.workspace_path, input.permission_mode)));

  server.registerTool("file_search", {
    title: "Search local text files",
    description: "Search text recursively under a disclosed path. Common dependency and runtime directories are skipped.",
    inputSchema: { query: z.string().min(1).max(10_000), path: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_results: z.number().int().min(1).max(2_000).default(200) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => result(direct.search(input.query, input.path, input.workspace_path, input.permission_mode, input.max_results)));

  server.registerTool("file_write", {
    title: "Write a local text file",
    description: "Write a complete text file. Disabled in read-only mode; workspace-write stays under the disclosed workspace.",
    inputSchema: { path: z.string().min(1), content: z.string().max(5_000_000), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async input => result(direct.write(input.path, input.content, input.workspace_path, input.permission_mode)));

  server.registerTool("terminal_start", {
    title: "Start a local terminal command",
    description: "Start an asynchronous PowerShell command on Windows (sh on Linux). Direct terminal execution is disabled in read-only mode.",
    inputSchema: { command: z.string().min(1).max(100_000), cwd: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => result(direct.startTerminal(input.command, input.cwd, input.workspace_path, input.permission_mode)));

  server.registerTool("terminal_status", {
    title: "Get terminal command status",
    description: "Poll an asynchronous direct terminal command and retrieve its bounded output.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => result(direct.terminal(job_id)));

  server.registerTool("terminal_cancel", {
    title: "Cancel terminal command",
    description: "Cancel an owned direct terminal process.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => result(direct.cancelTerminal(job_id)));

  try {
    await server.connect(new StdioServerTransport());
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
