import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { DirectToolService } from "../../standalone/direct-tools";
import { IMAGE_PREVIEW_HTML, IMAGE_PREVIEW_MIME_TYPE, IMAGE_PREVIEW_RESOURCE_URI } from "../../standalone/image-preview";
import { LunaJobManager } from "../../standalone/luna-jobs";
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
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI },
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
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
  const server = new McpServer({ name: "webgpt-luna", version: "0.1.0" });
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

  server.registerTool("codexluna_start", {
    title: "Start Luna execution",
    description: "Start an asynchronous Codex Luna task for this ChatGPT conversation. Tasks in one web_session_id run serially and reuse its Luna session.",
    inputSchema: {
      web_session_id: sessionId,
      prompt: z.string().min(1).max(1_000_000),
      workspace_path: z.string().min(1).max(16_384),
      model: z.string().min(1).max(200).default("gpt-5.6-luna"),
      reasoning_effort: reasoning.default("high"),
      fast: z.boolean().default(true),
      permission_mode: sandbox.default("workspace-write"),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).default(900_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async input => {
    const job = jobs.start({
      webSessionId: input.web_session_id,
      prompt: input.prompt,
      cwd: input.workspace_path,
      model: input.model,
      reasoning: input.reasoning_effort,
      fast: input.fast,
      sandbox: input.permission_mode,
      timeoutMs: input.timeout_ms,
    });
    return result({ job_id: job.id, status: job.status, workspace_path: job.cwd, permission_mode: job.sandbox, timeout_ms: job.timeoutMs });
  });

  server.registerTool("codexluna_status", {
    title: "Get Luna execution status",
    description: "Poll an asynchronous Luna task. Completed results are compact; full JSONL remains in the local log.",
    inputSchema: { job_id: z.string().uuid() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ job_id }) => {
    const job = jobs.get(job_id);
    return result({
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
  }, async ({ job_id }) => result({ ...jobs.cancel(job_id) }));

  server.registerTool("codexluna_session", {
    title: "Inspect Luna session binding",
    description: "Inspect the durable Luna session bound to a ChatGPT web conversation.",
    inputSchema: { web_session_id: sessionId },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ web_session_id }) => result({ binding: jobs.store.ensureBinding(web_session_id) }));

  server.registerTool("file_read", {
    title: "Read a local text file or image",
    description: "Read text directly or transfer a PNG, JPEG, GIF, or WebP image as a native MCP image content block so ChatGPT can inspect it. The resolved path and disclosed workspace are checked unless full access is selected. Images default to a 10 MB transfer limit and never appear as base64 text.",
    inputSchema: { path: z.string().min(1), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_chars: z.number().int().min(1).max(1_000_000).default(200_000), max_image_bytes: z.number().int().min(1).max(20_000_000).default(10_000_000) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI },
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/toolInvocation/invoking": "正在读取本地文件",
      "openai/toolInvocation/invoked": "本地文件读取完成",
    },
  }, async input => fileReadResult(direct.read(input.path, input.workspace_path, input.permission_mode, input.max_chars, input.max_image_bytes)));

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
