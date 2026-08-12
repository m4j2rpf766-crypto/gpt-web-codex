import { expect, test } from "bun:test";
import {
  LUNA_TOOL_BINDING_ACK,
  NORMAL_CHAT_URL,
  SESSION_MEMORY_BOUNDARY_ACK,
  conversationIdFromUrl,
  memoryBoundaryPrompt,
  toolBindingPrompt,
  webSessionIdFromUrl,
} from "../launcher/electron/web-session.cjs";

test("normal ChatGPT conversation URL deterministically identifies a web session", () => {
  expect(NORMAL_CHAT_URL).toBe("https://chatgpt.com/");
  expect(conversationIdFromUrl("https://chatgpt.com/c/019ff1b5-0747-7bc0-8871-977533a91227"))
    .toBe("019ff1b5-0747-7bc0-8871-977533a91227");
  expect(webSessionIdFromUrl("https://chatgpt.com/c/019ff1b5-0747-7bc0-8871-977533a91227"))
    .toBe("chatgpt:019ff1b5-0747-7bc0-8871-977533a91227");
  expect(webSessionIdFromUrl("https://chatgpt.com/g/g-project/c/019ff1b5-0747-7bc0-8871-977533a91227?model=gpt-5#latest"))
    .toBe("chatgpt:019ff1b5-0747-7bc0-8871-977533a91227");
  expect(webSessionIdFromUrl("https://chatgpt.com/?temporary-chat=true")).toBeNull();
  expect(webSessionIdFromUrl("https://chatgpt.com/c/019ff1b5-0747-7bc0-8871-977533a91227/extra")).toBeNull();
  expect(webSessionIdFromUrl("https://chatgpt.com/share/019ff1b5-0747-7bc0-8871-977533a91227")).toBeNull();
  expect(webSessionIdFromUrl("https://example.com/c/019ff1b5-0747-7bc0-8871-977533a91227")).toBeNull();
});

test("visible bootstrap states the memory limitation before exposing tools", () => {
  const boundary = memoryBoundaryPrompt();
  expect(boundary).toContain(SESSION_MEMORY_BOUNDARY_ACK);
  expect(boundary).toContain("设置 > 个性化 > 记忆");
  expect(boundary).toContain("不要主动把这些内容写入");
  expect(boundary).toContain("不要调用任何本地工具");

  const binding = toolBindingPrompt("chatgpt:019ff1b5-0747-7bc0-8871-977533a91227");
  expect(binding).toContain(LUNA_TOOL_BINDING_ACK);
  expect(binding).toContain("workspace_path");
  expect(binding).toContain("permission_mode");
  expect(binding).toContain("codexluna_*");
});
