export const SESSION_POLICY_VERSION = 1 as const;

export const SESSION_BOUNDARY_NOTICE = [
  "【GPT Web Codex 会话边界声明】",
  "本次工具会话采用严格的会话级上下文边界。GPT Web Codex 创建的网页会话绑定、Luna 上下文、任务状态、工作区信息与本地执行记录，只能用于当前 web_session_id 对应的网页对话。",
  "不得主动把本对话中的内容、摘要、偏好、路径、文件信息、代码、任务结果、Luna 上下文或推断信息写入、更新、合并、同步或迁移到任何跨对话长期记忆，也不得将其他网页对话的本地会话绑定到当前对话。",
  "允许为恢复同一个网页对话而在本机持久化该 web_session_id 的 Luna session、任务状态和必要日志；这些数据不得被其他网页会话自动继承。",
  "如果用户以后明确要求执行跨对话记忆操作，应先单独说明影响并重新取得明确授权；GPT Web Codex 本身不提供 ChatGPT 账户长期记忆的写入能力。",
  "此声明约束当前 MCP 工具流程，但不会修改或关闭 ChatGPT 账户在“设置 > 个性化 > 记忆”中的产品级功能。若账户记忆已启用，ChatGPT 产品自身的自动记忆行为不受本地 MCP 直接控制。",
  "无需要求用户回复确认口令。向用户简短显示当前工作区、权限模式和会话边界后，即可继续处理其已授权的任务。",
].join("\n");

export const SESSION_POLICY = Object.freeze({
  version: SESSION_POLICY_VERSION,
  scope: "current_web_session_only" as const,
  allow_long_term_memory_write: false,
  allow_long_term_memory_update: false,
  allow_cross_chat_migration: false,
  allow_cross_chat_binding_reuse: false,
  allow_same_session_persistence: true,
  requires_acknowledgement: false,
  account_memory_controlled_by_mcp: false,
});

export const COMPACT_SESSION_POLICY =
  "current-web-session-only; no-active-long-term-memory-write-or-update; no-cross-chat-migration; same-session-local-resume-allowed";

export const MCP_SERVER_INSTRUCTIONS = [
  "Use codexluna_init before the first codexluna_start in a new ChatGPT conversation.",
  "Treat the returned web_session_id as private to that conversation and reuse it only when continuing the same conversation.",
  "When the user asks to see or preview a local image, locating a path or receiving Luna text is not a rendered preview. Use file_image_preview directly, or poll codexluna_status until it returns image_preview_rendered=true. Never claim that an image is displayed unless an MCP tool result actually contains the image preview.",
  SESSION_BOUNDARY_NOTICE,
].join("\n\n");
