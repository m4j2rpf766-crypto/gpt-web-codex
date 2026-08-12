"use strict";

const Core = globalThis.GptWebCodexCore;
const STATUS_ID = "gpt-web-codex-status";
let bootstrapRunning = false;

function visible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return element.isConnected && rect.width > 0 && rect.height > 0
    && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function label(element) {
  return (element.getAttribute("aria-label") || element.textContent || "").replace(/\s+/g, " ").trim();
}

function point(element) {
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
}

function selected(element) {
  return ["aria-selected", "aria-pressed", "aria-checked"].some(name => element.getAttribute(name) === "true")
    || ["active", "checked", "on", "selected"].includes(element.getAttribute("data-state"));
}

function inspectExperience() {
  for (const group of [...document.querySelectorAll('[role="radiogroup"]')].filter(visible)) {
    const radios = [...group.querySelectorAll('[role="radio"]')].filter(visible);
    const chat = radios.find(element => Core.CHAT_LABELS.has(label(element)));
    const work = radios.find(element => Core.WORK_LABELS.has(label(element)));
    if (!chat || !work) continue;
    const chatSelected = selected(chat);
    const workSelected = selected(work);
    return {
      selected: chatSelected !== workSelected ? (chatSelected ? "chat" : "work") : null,
      chatPoint: point(chat),
    };
  }
  return { selected: null, chatPoint: null };
}

function composer() {
  return [...document.querySelectorAll('#prompt-textarea, [contenteditable="true"][data-lexical-editor="true"]')].find(visible) || null;
}

function assistantHas(text) {
  return [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .some(element => (element.innerText || element.textContent || "").includes(text));
}

function responseStopButton() {
  return [...document.querySelectorAll('button[data-testid="stop-button"], button')]
    .filter(visible)
    .find(element => element.getAttribute("data-testid") === "stop-button"
      || /^(Stop|停止回答)$/i.test(label(element))) || null;
}

function responseInProgress() {
  return Boolean(responseStopButton());
}

function sendButton() {
  return [...document.querySelectorAll('button[data-testid="send-button"]')]
    .find(element => visible(element) && !element.disabled) || null;
}

function composerText(element = composer()) {
  return (element?.innerText || element?.textContent || "").replace(/\r\n/g, "\n").trim();
}

function rateLimitDialogVisible() {
  return [...document.querySelectorAll('[role="dialog"]')].filter(visible)
    .some(element => /请求过于频繁|too many requests/i.test(element.innerText || element.textContent || ""));
}

async function waitFor(probe, description, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.ok === false) throw new Error(response.error || "Extension operation failed");
  return response;
}

function setStatus(message, tone = "active") {
  let status = document.getElementById(STATUS_ID);
  if (!status) {
    status = document.createElement("div");
    status.id = STATUS_ID;
    Object.assign(status.style, {
      position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647",
      maxWidth: "360px", padding: "12px 14px", borderRadius: "12px",
      color: "white", font: "13px/1.45 system-ui, sans-serif", boxShadow: "0 8px 32px #0008",
    });
    document.documentElement.append(status);
  }
  status.style.background = tone === "error" ? "#8b1d1d" : tone === "done" ? "#176b3a" : "#202123";
  status.textContent = message;
  if (tone === "done") setTimeout(() => status.remove(), 5000);
}

async function ensureChatMode() {
  const mode = await waitFor(() => {
    const current = inspectExperience();
    return current.chatPoint ? current : null;
  }, "the Chat/Work selector", 30000);
  if (mode.selected === "chat") return;
  setStatus("正在从“工作”切换到“聊天”…");
  await request({ type: "native-click", point: mode.chatPoint });
  await waitFor(() => inspectExperience().selected === "chat", "Chat mode", 5000);
}

async function submit(text) {
  if (rateLimitDialogVisible()) throw new Error("ChatGPT 请求过于频繁；请等待几分钟后刷新此页面，扩展会继续初始化");
  const input = await waitFor(composer, "the ChatGPT composer", 30000);
  const draft = composerText(input);
  if (draft && Core.canonicalText(draft) !== Core.canonicalText(text)) {
    throw new Error("输入框中存在其他未发送内容，已停止自动初始化以免覆盖");
  }
  if (!draft) await request({ type: "native-fill", point: point(input), text });
  const send = await waitFor(sendButton, "the enabled ChatGPT send button", 15000);
  await request({ type: "native-click", point: point(send) });
}

async function waitForAcknowledgement(text) {
  await waitFor(() => assistantHas(text), text);
  const naturalDeadline = Date.now() + 5000;
  while (responseInProgress() && Date.now() < naturalDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const stop = responseStopButton();
  if (stop) {
    setStatus(`已收到 ${text}，正在结束停滞的网页生成…`);
    await request({ type: "native-click", point: point(stop) });
  }
  await waitFor(() => !responseInProgress(), `${text} response completion`, 10000);
}

async function bootstrap() {
  if (bootstrapRunning) return;
  bootstrapRunning = true;
  try {
    let webSessionId = Core.webSessionIdFromUrl(location.href);
    if (!webSessionId) {
      setStatus("正在确认 ChatGPT 聊天模式…");
      await ensureChatMode();
      setStatus("正在声明本次会话的记忆边界…");
      await submit(Core.memoryBoundaryPrompt());
      await waitForAcknowledgement(Core.SESSION_MEMORY_BOUNDARY_ACK);
      webSessionId = await waitFor(() => Core.webSessionIdFromUrl(location.href), "a stable /c/ conversation URL", 60000);
    } else if (!assistantHas(Core.SESSION_MEMORY_BOUNDARY_ACK) && !assistantHas(Core.LUNA_TOOL_BINDING_ACK)) {
      throw new Error("当前是未由扩展初始化的既有会话；不会向其中补发初始化提示词");
    }
    if (!assistantHas(Core.LUNA_TOOL_BINDING_ACK)) {
      await waitForAcknowledgement(Core.SESSION_MEMORY_BOUNDARY_ACK);
      setStatus("正在绑定 WebGPT Luna 本地工具…");
      await submit(Core.toolBindingPrompt(webSessionId));
      await waitForAcknowledgement(Core.LUNA_TOOL_BINDING_ACK);
    }
    if (Core.webSessionIdFromUrl(location.href) !== webSessionId) throw new Error("The conversation changed during initialization");
    localStorage.setItem(`webgpt.boundary.${webSessionId}`, "1");
    await request({ type: "bootstrap-finished" });
    await captureHistory();
    setStatus("GPT Web Codex 初始化完成", "done");
  } catch (error) {
    setStatus(`GPT Web Codex 初始化失败：${error.message}`, "error");
  } finally {
    bootstrapRunning = false;
  }
}

async function captureHistory() {
  const id = Core.conversationIdFromUrl(location.href);
  if (!id) return;
  const title = (document.title || "ChatGPT conversation").replace(/\s*[—-]\s*ChatGPT\s*$/i, "").trim();
  await request({
    type: "history-upsert",
    entry: { id, title: title || "ChatGPT conversation", url: `https://chatgpt.com/c/${id}`, updatedAt: Date.now() },
  });
}

function interruptedBootstrapIsRecoverable() {
  const webSessionId = Core.webSessionIdFromUrl(location.href);
  return Boolean(webSessionId)
    && assistantHas(Core.SESSION_MEMORY_BOUNDARY_ACK)
    && !assistantHas(Core.LUNA_TOOL_BINDING_ACK)
    && Core.canonicalText(composerText()) === Core.canonicalText(Core.toolBindingPrompt(webSessionId));
}

async function start() {
  await captureHistory().catch(() => {});
  const state = await request({ type: "bootstrap-state" }).catch(() => ({ pending: false }));
  if (state.pending) {
    await bootstrap();
    return;
  }
  if (Core.webSessionIdFromUrl(location.href)) {
    const recoverable = await waitFor(interruptedBootstrapIsRecoverable, "an interrupted extension bootstrap", 10000)
      .catch(() => false);
    if (recoverable) await bootstrap();
  }
}

void start();
let lastUrl = location.href;
let lastTitle = document.title;
new MutationObserver(() => {
  if (location.href === lastUrl && document.title === lastTitle) return;
  lastUrl = location.href;
  lastTitle = document.title;
  void captureHistory().catch(() => {});
}).observe(document.documentElement, { childList: true, subtree: true });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || Core.conversationIdFromUrl(location.href)) return;
  if (Object.keys(changes).some(key => key.startsWith("bootstrap:") && changes[key].newValue)) {
    void bootstrap();
  }
});
