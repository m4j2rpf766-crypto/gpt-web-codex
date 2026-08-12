const fs = require("node:fs");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 420;
const SESSION_REFRESH_REMINDER_INTERVAL_MS = 48 * 60 * 60 * 1000;
const MAX_CONVERSATION_HISTORY = 50;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,256}$/;

const DEFAULT_STATE = Object.freeze({
  version: 1,
  language: null,
  onboardingComplete: false,
  githubOpened: false,
  xOpened: false,
  keepRunningOnClose: true,
  browserSmokePassed: false,
  browserSmokeVersion: null,
  sidebarOpen: true,
  sidebarWidth: 252,
  mcpGuideStep: 0,
  sessionRefreshReminderAt: null,
  conversationHistory: [],
});

function normalizeConversationTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/g, " ").trim().replace(/\s*[-–—]\s*ChatGPT$/i, "").trim();
  if (!title || title.length > 240) return null;
  return title;
}

function sanitizeConversationHistory(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const id = typeof candidate.id === "string" && CONVERSATION_ID_PATTERN.test(candidate.id)
      ? candidate.id
      : null;
    const title = normalizeConversationTitle(candidate.title);
    const visitedAt = typeof candidate.visitedAt === "string" && Number.isFinite(Date.parse(candidate.visitedAt))
      ? candidate.visitedAt
      : null;
    if (!id || !title || !visitedAt || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, title, visitedAt });
    if (result.length >= MAX_CONVERSATION_HISTORY) break;
  }
  return result;
}

function upsertConversationHistory(history, conversation) {
  const current = sanitizeConversationHistory(history);
  const id = typeof conversation?.id === "string" && CONVERSATION_ID_PATTERN.test(conversation.id)
    ? conversation.id
    : null;
  const visitedAt = typeof conversation?.visitedAt === "string"
    && Number.isFinite(Date.parse(conversation.visitedAt))
    ? conversation.visitedAt
    : null;
  if (!id || !visitedAt) throw new Error("Conversation history entry is invalid");
  const existing = current.find(entry => entry.id === id);
  const incomingTitle = normalizeConversationTitle(conversation.title);
  const genericTitle = !incomingTitle || /^ChatGPT(?: conversation)?$/i.test(incomingTitle);
  const title = genericTitle && existing ? existing.title : (incomingTitle || `Conversation ${id.slice(0, 8)}`);
  return [
    { id, title, visitedAt },
    ...current.filter(entry => entry.id !== id),
  ].slice(0, MAX_CONVERSATION_HISTORY);
}

function nextSessionRefreshReminderAt(now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error("Session refresh reminder time must be finite");
  return new Date(now + SESSION_REFRESH_REMINDER_INTERVAL_MS).toISOString();
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || parsed.version !== 1) return { ...DEFAULT_STATE };
    const state = {
      ...DEFAULT_STATE,
      language: parsed.language,
      onboardingComplete: parsed.onboardingComplete,
      githubOpened: parsed.githubOpened,
      xOpened: parsed.xOpened,
      keepRunningOnClose: parsed.keepRunningOnClose,
      browserSmokePassed: parsed.browserSmokePassed,
      browserSmokeVersion: parsed.browserSmokeVersion,
      sidebarOpen: parsed.sidebarOpen,
      sidebarWidth: parsed.sidebarWidth,
      mcpGuideStep: parsed.mcpGuideStep,
      sessionRefreshReminderAt: parsed.sessionRefreshReminderAt,
      conversationHistory: sanitizeConversationHistory(parsed.conversationHistory),
      ...(parsed.coreSetupComplete === undefined ? {} : { coreSetupComplete: parsed.coreSetupComplete }),
      ...(parsed.mcpSetupComplete === undefined ? {} : { mcpSetupComplete: parsed.mcpSetupComplete }),
      ...(parsed.mcpRuntimeInstalled === undefined ? {} : { mcpRuntimeInstalled: parsed.mcpRuntimeInstalled }),
    };
    if (state.language !== null && state.language !== "en" && state.language !== "zh-CN") {
      state.language = DEFAULT_STATE.language;
    }
    for (const key of [
      "onboardingComplete",
      "githubOpened",
      "xOpened",
      "keepRunningOnClose",
      "browserSmokePassed",
      "sidebarOpen",
    ]) {
      if (typeof state[key] !== "boolean") state[key] = DEFAULT_STATE[key];
    }
    if (state.browserSmokeVersion !== null
      && (typeof state.browserSmokeVersion !== "string" || state.browserSmokeVersion.length > 128)) {
      state.browserSmokeVersion = DEFAULT_STATE.browserSmokeVersion;
    }
    if (!Number.isFinite(state.sidebarWidth)
      || state.sidebarWidth < SIDEBAR_MIN_WIDTH
      || state.sidebarWidth > SIDEBAR_MAX_WIDTH) {
      state.sidebarWidth = DEFAULT_STATE.sidebarWidth;
    }
    if (!Number.isInteger(state.mcpGuideStep) || state.mcpGuideStep < 0 || state.mcpGuideStep > 2) {
      state.mcpGuideStep = DEFAULT_STATE.mcpGuideStep;
    }
    if (state.sessionRefreshReminderAt !== null
      && (typeof state.sessionRefreshReminderAt !== "string"
        || !Number.isFinite(Date.parse(state.sessionRefreshReminderAt)))) {
      state.sessionRefreshReminderAt = DEFAULT_STATE.sessionRefreshReminderAt;
    }
    for (const key of [
      "coreSetupComplete",
      "mcpSetupComplete",
      "mcpRuntimeInstalled",
    ]) {
      if (state[key] !== undefined && typeof state[key] !== "boolean") delete state[key];
    }
    return state;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(filePath, state) {
  writePrivateFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function validateSidebarState(value) {
  if (!value || typeof value !== "object" || typeof value.open !== "boolean") {
    throw new Error("Sidebar state is invalid");
  }
  if (!Number.isFinite(value.width) || value.width < SIDEBAR_MIN_WIDTH || value.width > SIDEBAR_MAX_WIDTH) {
    throw new Error(`Sidebar width must be between ${SIDEBAR_MIN_WIDTH} and ${SIDEBAR_MAX_WIDTH}`);
  }
  return { sidebarOpen: value.open, sidebarWidth: Math.round(value.width) };
}

function createStateStore(filePath) {
  let state = readState(filePath);
  // Rewrite once on load so retired routing/autostart keys do not linger in
  // persisted launcher state after the standalone migration.
  writeState(filePath, state);
  return {
    read() {
      return structuredClone(state);
    },
    update(patch) {
      const next = { ...state, ...patch, version: 1 };
      writeState(filePath, next);
      state = next;
      return structuredClone(next);
    },
  };
}

module.exports = {
  MAX_CONVERSATION_HISTORY,
  SESSION_REFRESH_REMINDER_INTERVAL_MS,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  createStateStore,
  nextSessionRefreshReminderAt,
  sanitizeConversationHistory,
  upsertConversationHistory,
  validateSidebarState,
};
