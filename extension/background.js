"use strict";

const DEBUG_VERSION = "1.3";
const PENDING_PREFIX = "bootstrap:";

function pendingKey(tabId) {
  return `${PENDING_PREFIX}${tabId}`;
}

async function withDebugger(tabId, action) {
  const target = { tabId };
  await chrome.debugger.attach(target, DEBUG_VERSION);
  try {
    return await action((method, params = {}) => chrome.debugger.sendCommand(target, method, params));
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

async function trustedClick(tabId, point) {
  return withDebugger(tabId, async send => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await new Promise(resolve => setTimeout(resolve, 60));
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    });
  });
}

async function trustedFill(tabId, point, text) {
  return withDebugger(tabId, async send => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
    });
    await send("Input.insertText", { text });
  });
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
    if (message?.type === "native-click") {
      if (!tabId) throw new Error("The ChatGPT tab is unavailable");
      await trustedClick(tabId, message.point);
      return { ok: true };
    }
    if (message?.type === "native-fill") {
      if (!tabId) throw new Error("The ChatGPT tab is unavailable");
      await trustedFill(tabId, message.point, message.text);
      return { ok: true };
    }
    if (message?.type === "bootstrap-state") {
      if (!tabId) return { pending: false };
      const key = pendingKey(tabId);
      const value = await chrome.storage.session.get(key);
      return { pending: Boolean(value[key]) };
    }
    if (message?.type === "bootstrap-finished") {
      if (tabId) await chrome.storage.session.remove(pendingKey(tabId));
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
      await chrome.storage.session.set({ [pendingKey(tab.id)]: { requestedAt: Date.now() } });
      await chrome.tabs.update(tab.id, { url: "https://chatgpt.com/" });
    } else {
      await chrome.tabs.update(tab.id, { url: `https://chatgpt.com/c/${message.conversationId}` });
    }
    return { ok: true };
  })().then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
