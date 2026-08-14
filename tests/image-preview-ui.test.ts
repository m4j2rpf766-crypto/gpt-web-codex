import { expect, test } from "bun:test";
import { IMAGE_PREVIEW_HTML } from "../src/standalone/image-preview";

interface FakeElement {
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  src: string;
  alt: string;
  listeners: Map<string, Array<() => void>>;
  addEventListener(type: string, listener: () => void): void;
}

function createElement(): FakeElement {
  return {
    hidden: false,
    disabled: false,
    textContent: "",
    src: "",
    alt: "",
    listeners: new Map(),
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    },
  };
}

function mountPreview(openai: Record<string, unknown>) {
  const elements = Object.fromEntries(
    ["card", "preview", "name", "detail", "status", "statusText", "retry"].map(id => [id, createElement()]),
  ) as Record<string, FakeElement>;
  const listeners = new Map<string, Array<(event: { source?: unknown; data?: unknown; detail?: unknown }) => void>>();
  const messages: Array<Record<string, unknown>> = [];
  const parent = { postMessage(message: Record<string, unknown>) { messages.push(message); } };
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const fakeWindow = {
    openai,
    parent,
    addEventListener(type: string, listener: (event: { source?: unknown; data?: unknown; detail?: unknown }) => void) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
  };
  const fakeDocument = { getElementById(id: string) { return elements[id]; } };
  const script = /<script>([\s\S]*)<\/script>/.exec(IMAGE_PREVIEW_HTML)?.[1];
  if (!script) throw new Error("Image preview script is missing");
  const execute = new Function("window", "document", "setTimeout", "clearTimeout", script);
  execute(
    fakeWindow,
    fakeDocument,
    (callback: () => void) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    (id: number) => timers.delete(id),
  );
  return {
    elements,
    messages,
    dispatchMessage(data: Record<string, unknown>) {
      for (const listener of listeners.get("message") ?? []) listener({ source: parent, data });
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("image preview persists a small widget snapshot and restores after iframe recreation", async () => {
  const previewId = "11111111-1111-4111-8111-111111111111";
  const dataUrl = "data:image/png;base64,aW1hZ2U=";
  let widgetState: unknown;
  const first = mountPreview({
    toolResponseMetadata: {
      mcp_tool_result: {
        _meta: {
          webgpt_image_preview: {
            preview_id: previewId,
            name: "refresh.png",
            mime_type: "image/png",
            bytes: 5,
            width: 1,
            height: 1,
            data_url: dataUrl,
          },
        },
      },
    },
    setWidgetState(value: unknown) { widgetState = value; },
  });
  expect(first.elements.preview.src).toBe(dataUrl);
  expect(JSON.stringify(widgetState)).toContain(previewId);
  expect(JSON.stringify(widgetState)).not.toContain(dataUrl);

  const initialize = first.messages.find(message => message.method === "ui/initialize");
  first.dispatchMessage({ jsonrpc: "2.0", id: initialize?.id, result: {} });
  await flushPromises();

  const second = mountPreview({ widgetState });
  const secondInitialize = second.messages.find(message => message.method === "ui/initialize");
  second.dispatchMessage({ jsonrpc: "2.0", id: secondInitialize?.id, result: {} });
  await flushPromises();
  const restore = second.messages.find(message => message.method === "tools/call");
  expect(restore).toMatchObject({
    method: "tools/call",
    params: { name: "file_image_preview_restore", arguments: { preview_id: previewId } },
  });
  second.dispatchMessage({
    jsonrpc: "2.0",
    id: restore?.id,
    result: {
      structuredContent: { preview_id: previewId, name: "refresh.png", mime_type: "image/png", bytes: 5 },
      _meta: {
        webgpt_image_preview: {
          preview_id: previewId,
          name: "refresh.png",
          mime_type: "image/png",
          bytes: 5,
          data_url: dataUrl,
        },
      },
    },
  });
  await flushPromises();
  expect(second.elements.preview.src).toBe(dataUrl);
  expect(second.elements.card.hidden).toBe(false);
  expect(second.elements.status.hidden).toBe(true);
});
