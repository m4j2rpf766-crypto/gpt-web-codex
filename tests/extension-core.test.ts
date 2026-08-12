import { describe, expect, test } from "bun:test";
const core = require("../extension/core.js");

describe("Chrome extension conversation contract", () => {
  test("derives stable Web session identity only from normal /c/ URLs", () => {
    expect(core.conversationIdFromUrl("https://chatgpt.com/c/abcDEF_123-xyz")).toBe("abcDEF_123-xyz");
    expect(core.webSessionIdFromUrl("https://chatgpt.com/c/abcDEF_123-xyz")).toBe("chatgpt:abcDEF_123-xyz");
    expect(core.conversationIdFromUrl("https://chatgpt.com/")).toBeNull();
    expect(core.conversationIdFromUrl("https://example.com/c/abcDEF_123-xyz")).toBeNull();
  });

  test("keeps the normal-chat boundary and Luna binding visible", () => {
    expect(core.memoryBoundaryPrompt()).toContain(core.SESSION_MEMORY_BOUNDARY_ACK);
    expect(core.memoryBoundaryPrompt()).toContain("不能替代或更改 ChatGPT 账户");
    const prompt = core.toolBindingPrompt("chatgpt:abcDEF_123-xyz");
    expect(prompt).toContain("WebGPT Luna Standalone");
    expect(prompt).toContain("chatgpt:abcDEF_123-xyz");
    expect(prompt).toContain(core.LUNA_TOOL_BINDING_ACK);
  });
});
