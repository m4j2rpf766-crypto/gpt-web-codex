(function (root) {
  "use strict";

  const CHATGPT_ORIGIN = "https://chatgpt.com";
  const SESSION_MEMORY_BOUNDARY_ACK = "SESSION_MEMORY_BOUNDARY_ACK";
  const LUNA_TOOL_BINDING_ACK = "LUNA_TOOL_BINDING_ACK";
  const CHAT_LABELS = new Set(["Chat", "聊天"]);
  const WORK_LABELS = new Set(["Work", "工作"]);

  function conversationIdFromUrl(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== CHATGPT_ORIGIN) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const marker = segments.lastIndexOf("c");
    if (marker < 0 || marker !== segments.length - 2) return null;
    const id = segments[marker + 1];
    return id && /^[A-Za-z0-9_-]{8,256}$/.test(id) ? id : null;
  }

  function webSessionIdFromUrl(value) {
    const id = conversationIdFromUrl(value);
    return id ? `chatgpt:${id}` : null;
  }

  function memoryBoundaryPrompt() {
    return [
      "【WebGPT Luna 会话边界声明｜由 GPT Web Codex 扩展自动发送，用户可见】",
      "本次正常 ChatGPT 对话中的上下文、工具结果、工作区信息与后续记忆，仅用于当前这一条对话。",
      "请不要主动把这些内容写入、更新或迁移到跨对话的长期记忆，也不要在其他对话中沿用。",
      "这是一条会话内行为约定，不能替代或更改 ChatGPT 账户在“设置 > 个性化 > 记忆”中的开关；若账户级记忆策略与此约定冲突，应明确告知用户。",
      "在确认此边界前不要调用任何本地工具。请只回复：SESSION_MEMORY_BOUNDARY_ACK",
    ].join("\n");
  }

  function toolBindingPrompt(webSessionId) {
    if (!/^chatgpt:[A-Za-z0-9_-]{8,256}$/.test(webSessionId)) throw new Error("Invalid WebGPT session id");
    return [
      "【WebGPT Luna 本地工具绑定｜由 GPT Web Codex 扩展自动发送，用户可见】",
      `本对话的稳定 web_session_id 是：${webSessionId}`,
      "本对话只能使用名为 WebGPT Luna Standalone 的连接器；不要调用旧 WebGPT Luna 或 Codex Native 连接器。",
      "调用 codexluna_* 工具时必须原样填写该值。codexluna 用于让网页 GPT 规划、由 Luna 执行并验证；file_* 与 terminal_* 是可并列直接使用的本地工具。",
      "第一次涉及本地操作前，先向用户明确显示将使用的 workspace_path 与 permission_mode。路径可由用户或你填写，不是固定路径。",
      "默认采用 workspace-write；只有用户明确选择时才使用 read-only 或 danger-full-access。长任务使用异步 start/status，不要因网页回答停止而取消 Luna。",
      "请只回复：LUNA_TOOL_BINDING_ACK",
    ].join("\n");
  }

  const api = {
    CHATGPT_ORIGIN,
    SESSION_MEMORY_BOUNDARY_ACK,
    LUNA_TOOL_BINDING_ACK,
    CHAT_LABELS,
    WORK_LABELS,
    conversationIdFromUrl,
    webSessionIdFromUrl,
    memoryBoundaryPrompt,
    toolBindingPrompt,
  };
  root.GptWebCodexCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
