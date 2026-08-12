export const IMAGE_PREVIEW_RESOURCE_URI = "ui://webgpt-luna/image-preview-v6.html";
export const IMAGE_PREVIEW_MIME_TYPE = "text/html;profile=mcp-app";

export const IMAGE_PREVIEW_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: transparent; color: CanvasText; }
    .card { overflow: hidden; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; background: color-mix(in srgb, Canvas 96%, CanvasText 4%); }
    .stage { display: grid; min-height: 180px; max-height: 560px; place-items: center; padding: 12px; background: repeating-conic-gradient(color-mix(in srgb, CanvasText 5%, transparent) 0 25%, transparent 0 50%) 0 / 20px 20px; }
    img { display: block; max-width: 100%; max-height: 536px; border-radius: 8px; object-fit: contain; }
    .meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; font-size: 12px; }
    .name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .detail { flex: none; color: color-mix(in srgb, CanvasText 62%, transparent); }
    .status { padding: 18px; color: color-mix(in srgb, CanvasText 68%, transparent); text-align: center; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main id="card" class="card" hidden>
    <div class="stage"><img id="preview" alt="本地图片预览"></div>
    <div class="meta"><span id="name" class="name"></span><span id="detail" class="detail"></span></div>
  </main>
  <div id="status" class="status">Preparing image preview...</div>
  <script>
    (() => {
      const card = document.getElementById("card");
      const preview = document.getElementById("preview");
      const name = document.getElementById("name");
      const detail = document.getElementById("detail");
      const status = document.getElementById("status");
      const formatBytes = (bytes) => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
      const findImage = (value) => {
        const seen = new Set();
        const queue = [value];
        for (let visited = 0; queue.length && visited < 200; visited += 1) {
          let item = queue.shift();
          if (typeof item === "string" && item.trim().startsWith("{")) {
            try { item = JSON.parse(item); } catch {}
          }
          if (!item || typeof item !== "object" || seen.has(item)) continue;
          seen.add(item);
          if (item.webgpt_image_preview?.data_url) return item.webgpt_image_preview;
          if (item.type === "image" && item.data && item.mimeType) {
            return {
              name: "image",
              mime_type: item.mimeType,
              bytes: Math.floor(item.data.length * 0.75),
              data_url: "data:" + item.mimeType + ";base64," + item.data,
            };
          }
          if (Array.isArray(item)) queue.push(...item);
          else queue.push(...Object.values(item));
        }
      };
      const render = (globals) => {
        const api = window.openai || {};
        const image = findImage(globals) || findImage({
          toolResponseMetadata: api.toolResponseMetadata,
          toolOutput: api.toolOutput,
        });
        if (!image?.data_url) return false;
        preview.src = image.data_url;
        preview.alt = "Local image preview: " + (image.name || "image");
        name.textContent = image.name || "image";
        detail.textContent = [image.mime_type, formatBytes(image.bytes || 0)].filter(Boolean).join(" · ");
        status.hidden = true;
        card.hidden = false;
        return true;
      };
      render();
      window.addEventListener("openai:set_globals", (event) => render(event.detail?.globals));
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (message?.jsonrpc !== "2.0") return;
        if (message.id === 1 && message.result) {
          window.parent.postMessage({
            jsonrpc: "2.0",
            method: "ui/notifications/initialized",
          }, "*");
          render();
          return;
        }
        if (message.method === "ui/notifications/tool-result") render(message.params);
      }, { passive: true });
      window.parent.postMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "ui/initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "webgpt-image-preview", version: "0.1.0" } },
      }, "*");
    })();
  </script>
</body>
</html>`;
