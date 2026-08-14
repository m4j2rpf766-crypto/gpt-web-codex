export const IMAGE_PREVIEW_RESOURCE_URI = "ui://webgpt-luna/image-preview-v9.html";
export const LEGACY_IMAGE_PREVIEW_RESOURCE_URIS = [
  "ui://webgpt-luna/image-preview-v8.html",
  "ui://webgpt-luna/image-preview-v7.html",
] as const;
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
    .retry { margin-top: 12px; padding: 7px 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 8px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); color: CanvasText; cursor: pointer; }
    .retry:disabled { cursor: wait; opacity: .6; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <main id="card" class="card" hidden>
    <div class="stage"><img id="preview" alt="本地图片预览"></div>
    <div class="meta"><span id="name" class="name"></span><span id="detail" class="detail"></span></div>
  </main>
  <div id="status" class="status">
    <div id="statusText">Preparing image preview...</div>
    <button id="retry" class="retry" type="button" hidden>重新加载图片</button>
  </div>
  <script>
    (() => {
      const card = document.getElementById("card");
      const preview = document.getElementById("preview");
      const name = document.getElementById("name");
      const detail = document.getElementById("detail");
      const status = document.getElementById("status");
      const statusText = document.getElementById("statusText");
      const retry = document.getElementById("retry");
      const pendingRequests = new Map();
      let nextRequestId = 1;
      let initialized = false;
      let rendered = false;
      let restoringPreviewId = null;
      let pendingRestoreId = null;
      let lastPreviewId = null;

      const formatBytes = (bytes) => bytes < 1024 ? bytes + " B" : bytes < 1048576 ? (bytes / 1024).toFixed(1) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
      const walk = (value, match) => {
        const seen = new Set();
        const queue = [value];
        for (let visited = 0; queue.length && visited < 240; visited += 1) {
          let item = queue.shift();
          if (typeof item === "string" && item.trim().startsWith("{")) {
            try { item = JSON.parse(item); } catch {}
          }
          if (!item || typeof item !== "object" || seen.has(item)) continue;
          seen.add(item);
          const found = match(item);
          if (found) return found;
          if (Array.isArray(item)) queue.push(...item);
          else queue.push(...Object.values(item));
        }
      };
      const findImage = (value) => walk(value, (item) => {
        if (item.webgpt_image_preview?.data_url) return item.webgpt_image_preview;
        if (item.type === "image" && item.data && item.mimeType) {
          return {
            name: "image",
            mime_type: item.mimeType,
            bytes: Math.floor(item.data.length * 0.75),
            data_url: "data:" + item.mimeType + ";base64," + item.data,
          };
        }
      });
      const findPreviewId = (value) => walk(value, (item) => {
        if (typeof item.webgpt_image_preview?.preview_id === "string") return item.webgpt_image_preview.preview_id;
        if (typeof item.preview_id === "string") return item.preview_id;
        if (typeof item.image_preview_id === "string") return item.image_preview_id;
      });
      const findJobStatus = (value) => walk(value, (item) => {
        if (typeof item.status === "string" && typeof item.job_id === "string") return item;
      });
      const sources = (globals) => {
        const api = window.openai || {};
        return {
          globals,
          toolResponseMetadata: api.toolResponseMetadata,
          toolOutput: api.toolOutput,
          widgetState: api.widgetState,
        };
      };
      const request = (method, params) => {
        const id = nextRequestId++;
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error("Host request timed out"));
          }, 15000);
          pendingRequests.set(id, { resolve, reject, timeout });
        });
      };
      const persistPreviewState = (image) => {
        if (!image?.preview_id || typeof window.openai?.setWidgetState !== "function") return;
        const snapshot = {
          privateContent: {
            webgpt_image_preview: {
              preview_id: image.preview_id,
              name: image.name || "image",
              mime_type: image.mime_type,
              bytes: image.bytes || 0,
              width: image.width,
              height: image.height,
            },
          },
        };
        try { window.openai.setWidgetState(snapshot); } catch {}
      };
      const renderImage = (image) => {
        if (!image?.data_url) return false;
        lastPreviewId = image.preview_id || lastPreviewId;
        preview.src = image.data_url;
        preview.alt = "Local image preview: " + (image.name || "image");
        name.textContent = image.name || "image";
        detail.textContent = [image.mime_type, formatBytes(image.bytes || 0)].filter(Boolean).join(" · ");
        status.hidden = true;
        retry.hidden = true;
        card.hidden = false;
        rendered = true;
        persistPreviewState(image);
        return true;
      };
      const showRestoring = () => {
        if (rendered) return;
        status.hidden = false;
        statusText.textContent = "正在恢复图片预览…";
        retry.hidden = true;
      };
      const showRestoreError = (error) => {
        if (rendered) return;
        status.hidden = false;
        statusText.textContent = "图片预览恢复失败：" + (error?.message || String(error));
        retry.hidden = !lastPreviewId;
        retry.disabled = false;
      };
      const callRestoreTool = async (previewId) => {
        try {
          return await request("tools/call", {
            name: "file_image_preview_restore",
            arguments: { preview_id: previewId },
          });
        } catch (error) {
          if (typeof window.openai?.callTool === "function") {
            return await window.openai.callTool("file_image_preview_restore", { preview_id: previewId });
          }
          throw error;
        }
      };
      const restorePreview = async (previewId) => {
        lastPreviewId = previewId;
        if (!initialized) {
          pendingRestoreId = previewId;
          return;
        }
        if (rendered || restoringPreviewId === previewId) return;
        restoringPreviewId = previewId;
        showRestoring();
        retry.disabled = true;
        try {
          const result = await callRestoreTool(previewId);
          if (!renderFrom(result)) throw new Error("本地缓存没有返回可显示的图片");
        } catch (error) {
          showRestoreError(error);
        } finally {
          restoringPreviewId = null;
          retry.disabled = false;
        }
      };
      const renderFrom = (globals) => {
        const allSources = sources(globals);
        const image = findImage(allSources);
        if (renderImage(image)) return true;
        const previewId = findPreviewId(allSources);
        if (previewId) {
          void restorePreview(previewId);
          return false;
        }
        const job = findJobStatus(allSources);
        if (job?.status === "completed") statusText.textContent = "任务已完成，但没有返回可显示的图片。";
        else if (job?.status) statusText.textContent = "Luna 任务状态：" + job.status + "，正在等待图片产物…";
        return false;
      };

      retry.addEventListener("click", () => {
        if (!lastPreviewId) return;
        rendered = false;
        card.hidden = true;
        void restorePreview(lastPreviewId);
      });
      preview.addEventListener("error", () => {
        rendered = false;
        card.hidden = true;
        showRestoreError(new Error("图片数据无法解码"));
      });
      preview.addEventListener("load", () => {
        try { window.openai?.notifyIntrinsicHeight?.(); } catch {}
      });
      window.addEventListener("openai:set_globals", (event) => renderFrom(event.detail?.globals));
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data;
        if (!message || message.jsonrpc !== "2.0") return;
        if (message.id !== undefined && pendingRequests.has(message.id)) {
          const pending = pendingRequests.get(message.id);
          pendingRequests.delete(message.id);
          clearTimeout(pending.timeout);
          if (message.error) pending.reject(new Error(message.error.message || "Host request failed"));
          else pending.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") renderFrom(message.params);
      }, { passive: true });

      renderFrom();
      request("ui/initialize", {
        protocolVersion: "2025-06-18",
        appCapabilities: {},
        appInfo: { name: "webgpt-image-preview", version: "0.2.0" },
      }).then(() => {
        initialized = true;
        window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
        const restoreId = pendingRestoreId;
        pendingRestoreId = null;
        if (restoreId) void restorePreview(restoreId);
        else renderFrom();
        setTimeout(() => {
          if (!rendered && !restoringPreviewId && !lastPreviewId) {
            statusText.textContent = "图片预览数据不可用，请重新调用图片预览工具。";
          }
        }, 2000);
      }).catch(showRestoreError);
    })();
  </script>
</body>
</html>`;
