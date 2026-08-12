"use strict";

const PENDING_PREFIX = "bootstrap:";

function pendingKey(tabId) {
  return `${PENDING_PREFIX}${tabId}`;
}

async function upsertHistory(entry) {
  const stored = await chrome.storage.local.get("conversationHistory");
  const previous = Array.isArray(stored.conversationHistory) ? stored.conversationHistory : [];
  const next = [entry, ...previous.filter(item => item && item.id !== entry.id)].slice(0, 50);
  await chrome.storage.local.set({ conversationHistory: next });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "popup-new-conversation" || message?.type === "popup-open-conversation") return false;
  const tabId = sender.tab?.id;
  (async () => {
    if (message?.type === "bootstrap-state") {
      if (!tabId) return { pending: false };
      const key = pendingKey(tabId);
      const value = await chrome.storage.local.get(key);
      const pending = value[key];
      if (pending && Date.now() - pending.requestedAt < 24 * 60 * 60 * 1000) return { pending: true };
      if (pending) await chrome.storage.local.remove(key);
      return { pending: false };
    }
    if (message?.type === "bootstrap-finished") {
      if (tabId) await chrome.storage.local.remove(pendingKey(tabId));
      return { ok: true };
    }
    if (message?.type === "history-upsert") {
      await upsertHistory(message.entry);
      return { ok: true };
    }
    throw new Error("Unknown extension message");
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "popup-new-conversation" && message?.type !== "popup-open-conversation") return false;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active Chrome tab");
    if (message.type === "popup-new-conversation") {
      await chrome.storage.local.set({ [pendingKey(tab.id)]: { requestedAt: Date.now() } });
      await chrome.tabs.update(tab.id, { url: "https://chatgpt.com/" });
    } else {
      await chrome.tabs.update(tab.id, { url: `https://chatgpt.com/c/${message.conversationId}` });
    }
    return { ok: true };
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
