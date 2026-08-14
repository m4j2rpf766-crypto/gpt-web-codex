import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { DirectToolService } from "../../standalone/direct-tools";
import { ImagePreviewCache, type CachedImagePreview } from "../../standalone/image-preview-cache";
import {
  IMAGE_PREVIEW_HTML,
  IMAGE_PREVIEW_MIME_TYPE,
  IMAGE_PREVIEW_RESOURCE_URI,
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS,
} from "../../standalone/image-preview";
import { LunaJobManager } from "../../standalone/luna-jobs";
import {
  COMPACT_SESSION_POLICY,
  MCP_SERVER_INSTRUCTIONS,
  SESSION_BOUNDARY_NOTICE,
  SESSION_POLICY,
  SESSION_POLICY_VERSION,
} from "../../standalone/session-policy";
import { LunaStateStore } from "../../standalone/state-store";
import type { LunaSessionBinding } from "../../standalone/types";
import { VERSION } from "../../version";

const sessionId = z.string().min(8).max(256);
const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const reasoning = z.enum(["none", "low", "medium", "high", "xhigh", "max"]);
const jobStatus = z.enum(["queued", "running", "completed", "failed", "timed_out", "cancelled"]);
const compactPolicySchema = z.string();
const noAuth = [{ type: "noauth" as const }];

function conversationSessionId(
  explicit: string | undefined,
  meta: Record<string, unknown> | undefined,
  allowCreate: boolean,
): string {
  if (explicit?.trim()) return explicit.trim();
  const chatSession = meta?.["openai/session"];
  if (typeof chatSession === "string" && chatSession.trim()) {
    const digest = createHash("sha256").update(chatSession.trim(), "utf8").digest("hex");
    return `chatgpt:${digest}`;
  }
  if (allowCreate) return `webgpt:${randomUUID()}`;
  throw new Error("web_session_id is required because ChatGPT did not provide openai/session metadata");
}

function publicBinding(binding: LunaSessionBinding | undefined) {
  if (!binding) return null;
  return {
    web_session_id: binding.webSessionId,
    luna_session_id: binding.lunaSessionId ?? null,
    workspace_path: binding.workspacePath ?? null,
    permission_mode: binding.permissionMode ?? null,
    model: binding.model ?? null,
    reasoning_effort: binding.reasoning ?? null,
    fast: binding.fast ?? null,
    timeout_ms: binding.timeoutMs ?? null,
    last_job_id: binding.lastJobId ?? null,
    created_at: binding.createdAt,
    updated_at: binding.updatedAt,
  };
}

function publicTerminal(job: {
  id: string; command: string; cwd: string; status: string; pid?: number; exitCode?: number | null;
  output: string; startedAt: string; finishedAt?: string;
}) {
  return {
    job_id: job.id,
    command: job.command,
    cwd: job.cwd,
    status: job.status,
    pid: job.pid ?? null,
    exit_code: job.exitCode ?? null,
    output: job.output,
    started_at: job.startedAt,
    finished_at: job.finishedAt ?? null,
  };
}

const terminalOutputSchema = {
  job_id: z.string().uuid(), command: z.string(), cwd: z.string(),
  status: z.enum(["running", "completed", "failed", "cancelled"]),
  pid: z.number().int().nullable(), exit_code: z.number().int().nullable(), output: z.string(),
  started_at: z.string(), finished_at: z.string().nullable(),
};

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{
      type: "text" as const,
      text: isError
        ? "Tool failed. Read structuredContent for the error details."
        : "Tool completed. Read structuredContent for the result.",
    }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function lunaResult(value: Record<string, unknown>, isError = false) {
  return result({ ...value, session_policy: COMPACT_SESSION_POLICY }, isError);
}

function imageMetadata(value: Extract<Awaited<ReturnType<DirectToolService["readForTransfer"]>>, { data: string }>) {
  return {
    path: value.path,
    mime_type: value.mimeType,
    bytes: value.bytes,
    ...(value.optimized === undefined ? {} : { optimized: value.optimized }),
    ...(value.sourceBytes === undefined ? {} : { source_bytes: value.sourceBytes }),
    ...(value.sourceMimeType === undefined ? {} : { source_mime_type: value.sourceMimeType }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
  };
}

function cachedImageMetadata(preview: CachedImagePreview) {
  return {
    preview_id: preview.previewId,
    name: preview.name,
    mime_type: preview.mimeType,
    bytes: preview.bytes,
    ...(preview.optimized === undefined ? {} : { optimized: preview.optimized }),
    ...(preview.sourceBytes === undefined ? {} : { source_bytes: preview.sourceBytes }),
    ...(preview.sourceMimeType === undefined ? {} : { source_mime_type: preview.sourceMimeType }),
    ...(preview.width === undefined ? {} : { width: preview.width }),
    ...(preview.height === undefined ? {} : { height: preview.height }),
  };
}

function cachedImageResult(preview: CachedImagePreview, text: string) {
  const metadata = cachedImageMetadata(preview);
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: metadata,
    _meta: {
      webgpt_image_preview: {
        ...metadata,
        data_url: `data:${preview.mimeType};base64,${preview.data}`,
      },
    },
  };
}

function lunaStatusResult(
  value: Record<string, unknown>,
  preview: Awaited<ReturnType<DirectToolService["readForTransfer"]>> | undefined,
  cache: ImagePreviewCache,
) {
  const cached = preview && "data" in preview ? cache.put(preview) : undefined;
  const structured = {
    ...value,
    image_preview_id: cached?.previewId ?? null,
    session_policy: COMPACT_SESSION_POLICY,
  };
  if (!cached) return result(structured);
  const metadata = cachedImageMetadata(cached);
  return {
    content: [
      { type: "text" as const, text: "Luna status is available in structuredContent; the image follows as native MCP content." },
      { type: "image" as const, data: cached.data, mimeType: cached.mimeType },
    ],
    structuredContent: structured,
    _meta: {
      webgpt_image_preview: {
        ...metadata,
        data_url: `data:${cached.mimeType};base64,${cached.data}`,
      },
    },
  };
}

function fileReadResult(value: Awaited<ReturnType<DirectToolService["readForTransfer"]>>) {
  if (!("data" in value)) return result({ ...value });
  const metadata = imageMetadata(value);
  return {
    content: [
      { type: "text" as const, text: "Image metadata is available in structuredContent; the image follows as native MCP content." },
      { type: "image" as const, data: value.data, mimeType: value.mimeType },
    ],
    structuredContent: metadata,
  };
}

function fileImagePreviewResult(
  value: Awaited<ReturnType<DirectToolService["readForTransfer"]>>,
  cache: ImagePreviewCache,
) {
  if (!("data" in value)) throw new Error(`Local file is not a supported image: ${value.path}`);
  const cached = cache.put(value);
  const metadata = imageMetadata(value);
  const cachedMetadata = cachedImageMetadata(cached);
  return {
    content: [{ type: "text" as const, text: `Displaying local image preview: ${cached.name}` }],
    structuredContent: { ...metadata, preview_id: cached.previewId },
    _meta: {
      webgpt_image_preview: {
        ...cachedMetadata,
        data_url: `data:${cached.mimeType};base64,${cached.data}`,
      },
    },
  };
}

export async function runChatGptMcpServer(options: { statePath?: string } = {}): Promise<void> {
  const jobs = new LunaJobManager(new LunaStateStore(options.statePath));
  const direct = new DirectToolService();
  const imagePreviews = new ImagePreviewCache(options.statePath);
  const server = new McpServer(
    { name: "gpt-web-codex", version: VERSION },
    { instructions: MCP_SERVER_INSTRUCTIONS },
  );
  const shutdown = () => {
    jobs.shutdown();
    direct.shutdown();
    setTimeout(() => process.exit(0), 0).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const registerImagePreviewResource = (name: string, uri: string) => {
    server.registerResource(name, uri, {
      title: "WebGPT local image preview",
      description: "Inline preview card for a verified local image returned by a GPT Web Codex tool.",
      mimeType: IMAGE_PREVIEW_MIME_TYPE,
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Displays a verified local image returned by GPT Web Codex directly in the conversation.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
      },
    }, async () => ({
      contents: [{
        uri,
        mimeType: IMAGE_PREVIEW_MIME_TYPE,
        text: IMAGE_PREVIEW_HTML,
        _meta: {
          ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDescription": "Displays a verified local image returned by GPT Web Codex directly in the conversation.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
        },
      }],
    }));
  };

  registerImagePreviewResource("webgpt-image-preview", IMAGE_PREVIEW_RESOURCE_URI);
  LEGACY_IMAGE_PREVIEW_RESOURCE_URIS.forEach((uri, index) => {
    registerImagePreviewResource(`webgpt-image-preview-legacy-${index + 1}`, uri);
  });

  server.registerTool("codexluna_init", {
    title: "Initialize this ChatGPT conversation",
    description: "Initialize or restore the GPT Web Codex binding for this ChatGPT conversation before its first Luna task. Omit web_session_id to use ChatGPT's stable conversation metadata when available, with a generated conversation-scoped fallback. Reuse the returned ID only in this conversation. Visibly summarize the returned workspace, permission, and memory boundary without asking for an ACK.",
    inputSchema: {
      web_session_id: sessionId.optional(),
      workspace_path: z.string().min(1).max(16_384),
      model: z.string().min(1).max(200).default("gpt-5.6-luna"),
      reasoning_effort: reasoning.default("low"),
      fast: z.boolean().default(true),
      permission_mode: sandbox.default("workspace-write"),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).default(900_000),
    },
    outputSchema: {
      initialized: z.boolean(), web_session_id: sessionId, workspace_path: z.string(), permission_mode: sandbox,
      model: z.string(), reasoning_effort: reasoning, fast: z.boolean(), timeout_ms: z.number().int(),
      luna_session_id: z.string().nullable(),
      session_policy: z.object({
        version: z.number().int(), scope: z.literal("current_web_session_only"),
        allow_long_term_memory_write: z.boolean(), allow_long_term_memory_update: z.boolean(),
        allow_cross_chat_migration: z.boolean(), allow_cross_chat_binding_reuse: z.boolean(),
        allow_same_session_persistence: z.boolean(), requires_acknowledgement: z.boolean(),
        account_memory_controlled_by_mcp: z.boolean(),
      }),
      session_boundary_notice: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async (input, extra) => {
    const webSessionId = conversationSessionId(input.web_session_id, extra._meta, true);
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
    description: "Start an asynchronous Codex Luna task after codexluna_init. Tasks in one conversation run serially and reuse its durable Luna session, including after a prior task completed, failed, timed out, or was cancelled. Omit web_session_id to use ChatGPT conversation metadata when available. Omitted execution settings inherit the initialized binding.",
    inputSchema: {
      web_session_id: sessionId.optional(),
      prompt: z.string().min(1).max(1_000_000),
      workspace_path: z.string().min(1).max(16_384).optional(),
      model: z.string().min(1).max(200).optional(),
      reasoning_effort: reasoning.optional(),
      fast: z.boolean().optional(),
      permission_mode: sandbox.optional(),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).optional(),
    },
    outputSchema: {
      web_session_id: sessionId, job_id: z.string().uuid(), status: jobStatus,
      workspace_path: z.string(), permission_mode: sandbox, timeout_ms: z.number().int(),
      session_policy: compactPolicySchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { securitySchemes: noAuth },
  }, async (input, extra) => {
    const webSessionId = conversationSessionId(input.web_session_id, extra._meta, false);
    const binding = jobs.store.binding(webSessionId);
    if (binding?.sessionPolicyVersion !== SESSION_POLICY_VERSION) {
      throw new Error("codexluna_init must initialize this ChatGPT conversation before codexluna_start");
    }
    const workspacePath = input.workspace_path ?? binding?.workspacePath;
    if (!workspacePath) throw new Error("codexluna_init must be called before codexluna_start, or workspace_path must be provided");
    const job = jobs.start({
      webSessionId,
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
    description: "Poll an asynchronous Luna task. Completed results are compact; full JSONL remains in the local log. For an image-preview task, this tool automatically returns the first verified local image artifact as native image content and an inline preview. Do not claim an image is displayed unless image_preview_rendered is true.",
    inputSchema: { job_id: z.string().uuid() },
    outputSchema: {
      web_session_id: sessionId, job_id: z.string().uuid(), status: jobStatus,
      luna_session_id: z.string().nullable(), workspace_path: z.string(),
      terminal_event: z.string().nullable(), final_message: z.string().nullable(), error: z.string().nullable(),
      mutation_seen: z.boolean(), event_count: z.number().int().nonnegative(),
      image_artifacts: z.array(z.string()), image_preview_rendered: z.boolean(),
      image_preview_error: z.string().nullable(), image_preview_id: z.string().uuid().nullable(),
      session_policy: compactPolicySchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      securitySchemes: noAuth,
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
      "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/toolInvocation/invoking": "正在检查 Luna 任务",
      "openai/toolInvocation/invoked": "Luna 任务状态已更新",
    },
  }, async ({ job_id }) => {
    const job = jobs.get(job_id);
    let preview: Awaited<ReturnType<DirectToolService["readForTransfer"]>> | undefined;
    let previewError: string | null = null;
    const previewPath = job.status === "completed" && job.wantsImagePreview ? job.imageArtifacts?.[0] : undefined;
    if (previewPath) {
      try {
        preview = await direct.readForTransfer(previewPath, job.cwd, job.sandbox, 1, 1_500_000);
      } catch (error) {
        previewError = error instanceof Error ? error.message : String(error);
      }
    }
    const imagePreviewRendered = Boolean(preview && "data" in preview);
    return lunaStatusResult({
      web_session_id: job.webSessionId,
      job_id: job.id, status: job.status, luna_session_id: job.lunaSessionId ?? null,
      workspace_path: job.cwd, terminal_event: job.terminalEvent ?? null, final_message: job.finalMessage ?? null,
      error: job.error ?? null, mutation_seen: job.mutationSeen, event_count: job.eventCount,
      image_artifacts: job.imageArtifacts ?? [], image_preview_rendered: imagePreviewRendered,
      image_preview_error: previewError,
    }, preview, imagePreviews);
  });

  server.registerTool("codexluna_cancel", {
    title: "Cancel Luna execution",
    description: "Cancel only the owned Luna process for a queued or running task; the conversation binding is preserved.",
    inputSchema: { job_id: z.string().uuid() },
    outputSchema: {
      web_session_id: sessionId, job_id: z.string().uuid(), status: jobStatus,
      luna_session_id: z.string().nullable(), session_policy: compactPolicySchema,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async ({ job_id }) => {
    const job = jobs.cancel(job_id);
    return lunaResult({
      web_session_id: job.webSessionId,
      job_id: job.id,
      status: job.status,
      luna_session_id: job.lunaSessionId ?? null,
    });
  });

  server.registerTool("codexluna_session", {
    title: "Inspect Luna session binding",
    description: "Inspect the durable Luna binding for this ChatGPT conversation. Omit web_session_id to use ChatGPT conversation metadata when available. This does not initialize a new conversation; use codexluna_init first.",
    inputSchema: { web_session_id: sessionId.optional() },
    outputSchema: {
      binding: z.object({
        web_session_id: sessionId, luna_session_id: z.string().nullable(), workspace_path: z.string().nullable(),
        permission_mode: sandbox.nullable(), model: z.string().nullable(), reasoning_effort: reasoning.nullable(),
        fast: z.boolean().nullable(), timeout_ms: z.number().int().nullable(), last_job_id: z.string().nullable(),
        created_at: z.string(), updated_at: z.string(),
      }).nullable(),
      session_policy: compactPolicySchema,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async ({ web_session_id }, extra) => {
    const resolvedSessionId = conversationSessionId(web_session_id, extra._meta, false);
    return lunaResult({ binding: publicBinding(jobs.store.binding(resolvedSessionId)) });
  });

  server.registerTool("file_read", {
    title: "Read a local text file or image",
    description: "Read text directly or transfer a PNG, JPEG, GIF, or WebP image as a native MCP image content block so ChatGPT can inspect it. Large or high-resolution images are automatically downscaled and encoded as a compact WebP preview without modifying the local file, reducing conversation-context usage. To visibly render an image in the conversation, call file_image_preview with the same path and workspace after inspection. The resolved path and disclosed workspace are checked unless full access is selected. Images default to a 1.5 MB transfer limit and never appear as base64 text.",
    inputSchema: { path: z.string().min(1), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_chars: z.number().int().min(1).max(1_000_000).default(200_000), max_image_bytes: z.number().int().min(50_000).max(20_000_000).default(1_500_000) },
    outputSchema: {
      path: z.string(),
      mime_type: z.string().optional(),
      bytes: z.number().int().nonnegative().optional(),
      optimized: z.boolean().optional(),
      source_bytes: z.number().int().nonnegative().optional(),
      source_mime_type: z.string().optional(),
      width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
      text: z.string().optional(),
      truncated: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => fileReadResult(await direct.readForTransfer(input.path, input.workspace_path, input.permission_mode, input.max_chars, input.max_image_bytes)));

  server.registerTool("file_image_preview", {
    title: "Display a local image inline",
    description: "Render a PNG, JPEG, GIF, or WebP file as a visible inline image card in the ChatGPT conversation. Large or high-resolution images are automatically downscaled and encoded as a compact WebP preview without modifying the local file. Use this presentation tool whenever the user asks to see or preview a local image. The resolved path and disclosed workspace are checked unless full access is selected.",
    inputSchema: { path: z.string().min(1), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_image_bytes: z.number().int().min(50_000).max(20_000_000).default(1_500_000) },
    outputSchema: {
      path: z.string(), mime_type: z.string(), bytes: z.number().int().nonnegative(), optimized: z.boolean().optional(),
      source_bytes: z.number().int().nonnegative().optional(), source_mime_type: z.string().optional(),
      width: z.number().int().nonnegative().optional(), height: z.number().int().nonnegative().optional(),
      preview_id: z.string().uuid(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      securitySchemes: noAuth,
      ui: { resourceUri: IMAGE_PREVIEW_RESOURCE_URI, visibility: ["model", "app"] },
      "ui/resourceUri": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/outputTemplate": IMAGE_PREVIEW_RESOURCE_URI,
      "openai/toolInvocation/invoking": "正在准备图片预览",
      "openai/toolInvocation/invoked": "图片预览已就绪",
    },
  }, async input => fileImagePreviewResult(
    await direct.readForTransfer(input.path, input.workspace_path, input.permission_mode, 1, input.max_image_bytes),
    imagePreviews,
  ));

  server.registerTool("file_image_preview_restore", {
    title: "Restore a local image preview",
    description: "Restore a previously rendered local image preview after its ChatGPT UI component is recreated. This app-only tool reads the bounded local preview cache by opaque ID and never rereads an arbitrary file path.",
    inputSchema: { preview_id: z.string().uuid() },
    outputSchema: {
      preview_id: z.string().uuid(), name: z.string(), mime_type: z.string(), bytes: z.number().int().nonnegative(),
      optimized: z.boolean().optional(), source_bytes: z.number().int().nonnegative().optional(),
      source_mime_type: z.string().optional(), width: z.number().int().nonnegative().optional(),
      height: z.number().int().nonnegative().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: {
      securitySchemes: noAuth,
      ui: { visibility: ["app"] },
      "openai/widgetAccessible": true,
      "openai/visibility": "private",
      "openai/toolInvocation/invoking": "正在恢复图片预览",
      "openai/toolInvocation/invoked": "图片预览已恢复",
    },
  }, async ({ preview_id }) => cachedImageResult(
    imagePreviews.get(preview_id),
    "The cached local image preview was restored for the existing UI component.",
  ));

  server.registerTool("file_list", {
    title: "List a local directory",
    description: "List direct children of a directory in the disclosed workspace.",
    inputSchema: { path: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    outputSchema: {
      path: z.string(), entries: z.array(z.object({
        name: z.string(), kind: z.enum(["directory", "file", "other"]), size: z.number().int().nonnegative().optional(),
      })),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => result(direct.list(input.path, input.workspace_path, input.permission_mode)));

  server.registerTool("file_search", {
    title: "Search local text files",
    description: "Search text recursively under a disclosed path. Common dependency and runtime directories are skipped.",
    inputSchema: { query: z.string().min(1).max(10_000), path: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write"), max_results: z.number().int().min(1).max(2_000).default(200) },
    outputSchema: {
      path: z.string(), matches: z.array(z.object({ path: z.string(), line: z.number().int().positive(), text: z.string() })),
      truncated: z.boolean(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => result(direct.search(input.query, input.path, input.workspace_path, input.permission_mode, input.max_results)));

  server.registerTool("file_write", {
    title: "Write a local text file",
    description: "Write a complete text file. Disabled in read-only mode; workspace-write stays under the disclosed workspace.",
    inputSchema: { path: z.string().min(1), content: z.string().max(5_000_000), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    outputSchema: { path: z.string(), bytes: z.number().int().nonnegative() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async input => result(direct.write(input.path, input.content, input.workspace_path, input.permission_mode)));

  server.registerTool("terminal_start", {
    title: "Start a local terminal command",
    description: "Start an asynchronous PowerShell command on Windows (sh on Linux). Direct terminal execution is disabled in read-only mode.",
    inputSchema: { command: z.string().min(1).max(100_000), cwd: z.string().default("."), workspace_path: z.string().min(1), permission_mode: sandbox.default("workspace-write") },
    outputSchema: terminalOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    _meta: { securitySchemes: noAuth },
  }, async input => result(publicTerminal(direct.startTerminal(input.command, input.cwd, input.workspace_path, input.permission_mode))));

  server.registerTool("terminal_status", {
    title: "Get terminal command status",
    description: "Poll an asynchronous direct terminal command. Output is bounded to the most recent 1,000,000 characters.",
    inputSchema: { job_id: z.string().uuid() },
    outputSchema: terminalOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async ({ job_id }) => result(publicTerminal(direct.terminal(job_id))));

  server.registerTool("terminal_cancel", {
    title: "Cancel terminal command",
    description: "Cancel an owned direct terminal process.",
    inputSchema: { job_id: z.string().uuid() },
    outputSchema: terminalOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    _meta: { securitySchemes: noAuth },
  }, async ({ job_id }) => result(publicTerminal(direct.cancelTerminal(job_id))));

  try {
    await server.connect(new StdioServerTransport());
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
