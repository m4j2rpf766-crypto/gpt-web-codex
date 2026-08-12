"use strict";

const status = document.getElementById("status");
const history = document.getElementById("history");
const newConversation = document.getElementById("new-conversation");

async function call(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "操作失败");
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentId = globalThis.GptWebCodexCore.conversationIdFromUrl(tab?.url || "");
  status.textContent = tab?.url?.startsWith("https://chatgpt.com/")
    ? currentId ? `当前会话：${currentId}` : "当前为 ChatGPT 新会话页"
    : "请先打开 chatgpt.com";
  newConversation.disabled = !tab?.id || !tab.url?.startsWith("https://chatgpt.com/");

  const stored = await chrome.storage.local.get("conversationHistory");
  const entries = Array.isArray(stored.conversationHistory) ? stored.conversationHistory : [];
  history.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "访问过的 /c/ 会话会显示在这里";
    history.append(empty);
    return;
  }
  for (const entry of entries) {
    const button = document.createElement("button");
    button.textContent = entry.title || entry.id;
    button.title = entry.id;
    button.addEventListener("click", async () => {
      await call({ type: "popup-open-conversation", conversationId: entry.id });
      window.close();
    });
    history.append(button);
  }
}

newConversation.addEventListener("click", async () => {
  status.textContent = "正在打开正常聊天并初始化…";
  try {
    await call({ type: "popup-new-conversation" });
    window.close();
  } catch (error) {
    status.textContent = error.message;
  }
});

void render();
