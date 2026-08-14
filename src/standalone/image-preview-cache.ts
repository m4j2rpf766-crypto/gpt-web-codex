import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../config";
import type { DirectImageFileRead } from "./direct-tools";
import { defaultStandaloneStatePath } from "./state-store";

const PREVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_FILE_BYTES = 30_000_000;
const PREVIEW_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

export interface CachedImagePreview {
  previewId: string;
  name: string;
  mimeType: DirectImageFileRead["mimeType"];
  data: string;
  bytes: number;
  optimized?: boolean;
  sourceBytes?: number;
  sourceMimeType?: DirectImageFileRead["sourceMimeType"];
  width?: number;
  height?: number;
  createdAt: string;
}

export function defaultImagePreviewCacheDir(statePath = defaultStandaloneStatePath()): string {
  return join(dirname(statePath), "image-previews");
}

function previewName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) || "image";
}

function assertCachedPreview(value: unknown, expectedId: string): asserts value is CachedImagePreview {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid cached image preview");
  const item = value as Record<string, unknown>;
  if (item.previewId !== expectedId || typeof item.name !== "string" || typeof item.mimeType !== "string"
    || typeof item.data !== "string" || typeof item.bytes !== "number" || typeof item.createdAt !== "string") {
    throw new Error("Invalid cached image preview");
  }
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mimeType)) {
    throw new Error("Invalid cached image MIME type");
  }
}

export class ImagePreviewCache {
  readonly directory: string;

  constructor(statePath = defaultStandaloneStatePath()) {
    this.directory = defaultImagePreviewCacheDir(statePath);
  }

  put(value: DirectImageFileRead): CachedImagePreview {
    const preview: CachedImagePreview = {
      previewId: randomUUID(),
      name: previewName(value.path),
      mimeType: value.mimeType,
      data: value.data,
      bytes: value.bytes,
      ...(value.optimized === undefined ? {} : { optimized: value.optimized }),
      ...(value.sourceBytes === undefined ? {} : { sourceBytes: value.sourceBytes }),
      ...(value.sourceMimeType === undefined ? {} : { sourceMimeType: value.sourceMimeType }),
      ...(value.width === undefined ? {} : { width: value.width }),
      ...(value.height === undefined ? {} : { height: value.height }),
      createdAt: new Date().toISOString(),
    };
    atomicWriteFile(this.pathFor(preview.previewId), `${JSON.stringify(preview)}\n`);
    this.prune();
    return preview;
  }

  get(previewId: string): CachedImagePreview {
    if (!PREVIEW_ID.test(previewId)) throw new Error("Invalid image preview ID");
    const path = this.pathFor(previewId);
    if (!existsSync(path)) throw new Error("This image preview is no longer available. Display the local image again to recreate it.");
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_CACHE_FILE_BYTES) throw new Error("Cached image preview is invalid");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    assertCachedPreview(parsed, previewId);
    const createdAt = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > PREVIEW_TTL_MS) {
      rmSync(path, { force: true });
      throw new Error("This image preview has expired. Display the local image again to recreate it.");
    }
    return parsed;
  }

  private pathFor(previewId: string): string {
    return join(this.directory, `${previewId}.json`);
  }

  private prune(): void {
    if (!existsSync(this.directory)) return;
    const now = Date.now();
    const entries = readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && PREVIEW_ID.test(entry.name.replace(/\.json$/i, "")) && entry.name.toLowerCase().endsWith(".json"))
      .map(entry => {
        const path = join(this.directory, entry.name);
        return { path, modifiedAt: statSync(path).mtimeMs };
      })
      .filter(entry => {
        if (now - entry.modifiedAt <= PREVIEW_TTL_MS) return true;
        rmSync(entry.path, { force: true });
        return false;
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
    for (const entry of entries.slice(MAX_CACHE_ENTRIES)) rmSync(entry.path, { force: true });
  }
}
