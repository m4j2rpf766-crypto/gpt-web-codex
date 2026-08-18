import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { LunaSandbox } from "./types";
import { resolveScopedPath } from "./direct-tools";

const DEFAULT_ALLOWED_ATTACHMENT_HOSTS = [
  "files.oaiusercontent.com",
  "oaiusercontent.com",
  "chatgpt.com",
  "openai.com",
  "cdn.openai.com",
  "oaistatic.com",
  "oaisdmntprkoreacentral.blob.core.windows.net",
] as const;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface ChatGptAttachmentReference {
  download_url: string;
  file_id: string;
  mime_type?: string;
  file_name?: string;
}

export interface AttachmentImportResult {
  path: string;
  bytes: number;
  declared_mime_type: string | null;
  detected_mime_type: string | null;
  mime_type_status: "matched" | "mismatched" | "unknown";
  sha256: string;
  verified: boolean;
  file_id: string;
  file_name: string | null;
  overwritten: boolean;
  warning: string | null;
}

interface ImportNetworkPolicy {
  allowedHosts?: readonly string[];
  allowHttpLoopback?: boolean;
}

interface ImportOptions {
  file: unknown;
  destination: string;
  workspacePath: string;
  permissionMode: LunaSandbox;
  overwrite?: boolean;
  expectedSha256?: string;
  maxBytes?: number;
  networkPolicy?: ImportNetworkPolicy;
}

interface VerifiedUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function isBlockedIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isProxyFakeIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  return Boolean(parts && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19));
}

function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family !== 6) return true;
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isBlockedIpv4(mapped);
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:");
}

function hostAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return allowedHosts.some(item => {
    const allowed = item.toLowerCase().replace(/\.$/, "");
    return host === allowed || host.endsWith(`.${allowed}`);
  });
}

export function isApprovedChatGptAttachmentHost(hostname: string): boolean {
  return hostAllowed(hostname, DEFAULT_ALLOWED_ATTACHMENT_HOSTS);
}

export function isAllowedProxyFakeIpForChatGptAttachment(hostname: string, address: string): boolean {
  return isApprovedChatGptAttachmentHost(hostname) && isProxyFakeIpv4(address);
}

export function parseAttachmentReference(value: unknown): ChatGptAttachmentReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ChatGPT must supply an attachment object containing download_url and file_id; a file id or URL string alone is not supported");
  }
  const record = value as Record<string, unknown>;
  const downloadUrl = typeof record.download_url === "string" ? record.download_url.trim() : "";
  const fileId = typeof record.file_id === "string" ? record.file_id.trim() : "";
  if (!downloadUrl || !fileId) throw new Error("Attachment download_url and file_id are required");
  if (/^(file|data|javascript):/i.test(downloadUrl)) throw new Error("Unsupported attachment URL scheme");
  return {
    download_url: downloadUrl,
    file_id: fileId,
    ...(typeof record.mime_type === "string" && record.mime_type.trim() ? { mime_type: record.mime_type.trim() } : {}),
    ...(typeof record.file_name === "string" && record.file_name.trim() ? { file_name: record.file_name.trim() } : {}),
  };
}

async function verifyDownloadUrl(rawUrl: string, policy: ImportNetworkPolicy = {}): Promise<VerifiedUrl> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Attachment download_url is not a valid URL"); }
  const loopbackHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(policy.allowHttpLoopback && loopbackHost && url.protocol === "http:")) {
    throw new Error("Attachment download_url must use HTTPS");
  }
  if (url.username || url.password) throw new Error("Attachment download_url must not include credentials");
  const allowedHosts = policy.allowedHosts ?? DEFAULT_ALLOWED_ATTACHMENT_HOSTS;
  const productionOriginPolicy = policy.allowedHosts === undefined;
  if (!loopbackHost && !hostAllowed(url.hostname, allowedHosts)) {
    throw new Error(`Attachment download_url host ${url.hostname} is not an approved ChatGPT file origin`);
  }
  if (loopbackHost && !policy.allowHttpLoopback) throw new Error("Attachment download_url points to a blocked host");

  if (net.isIP(url.hostname)) {
    if (isBlockedAddress(url.hostname) && !policy.allowHttpLoopback) {
      throw new Error("Attachment download_url resolves to a blocked address");
    }
    return { url, address: url.hostname, family: net.isIP(url.hostname) as 4 | 6 };
  }
  const records = await lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length) throw new Error("Attachment download_url hostname could not be resolved");
  for (const record of records) {
    const allowedProxyFakeIp = productionOriginPolicy
      && isAllowedProxyFakeIpForChatGptAttachment(url.hostname, record.address);
    if (isBlockedAddress(record.address) && !allowedProxyFakeIp && !(policy.allowHttpLoopback && loopbackHost)) {
      throw new Error("Attachment download_url resolves to a blocked address");
    }
  }
  const selected = records[0]!;
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

function responseMimeType(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return value.split(";", 1)[0]?.trim().toLowerCase() || null;
}

async function requestOnce(verified: VerifiedUrl, tempPath: string, maxBytes: number): Promise<{
  redirect?: string;
  bytes?: number;
  contentType?: string | null;
}> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const resolveOnce = (value: { redirect?: string; bytes?: number; contentType?: string | null }) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    };
    const transport = verified.url.protocol === "http:" ? http : https;
    const request = transport.get(verified.url, {
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers: { Accept: "*/*", "User-Agent": "gpt-web-codex-attachment-import/1" },
      lookup: ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: verified.address, family: verified.family }]);
        else callback(null, verified.address, verified.family);
      }) as never,
    }, response => {
      void (async () => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.resume();
          if (!location) throw new Error("Attachment download redirected without a Location header");
          resolveOnce({ redirect: new URL(location, verified.url).href });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          throw new Error(`Attachment download failed with HTTP ${status}`);
        }
        const declaredLength = Number(response.headers["content-length"] ?? "");
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy();
          throw new Error(`Attachment is too large; limit is ${maxBytes} bytes`);
        }
        const handle = await open(tempPath, "wx");
        let bytes = 0;
        try {
          for await (const chunk of response) {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += data.byteLength;
            if (bytes > maxBytes) {
              response.destroy();
              throw new Error(`Attachment exceeded the ${maxBytes}-byte import limit`);
            }
            await handle.write(data);
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        resolveOnce({ bytes, contentType: responseMimeType(response.headers["content-type"]) });
      })().catch(error => {
        response.destroy();
        rejectOnce(error);
      });
    });
    request.once("timeout", () => request.destroy(new Error("Attachment download timed out")));
    request.once("error", rejectOnce);
  });
}

async function downloadAttachment(
  initialUrl: string,
  tempPath: string,
  maxBytes: number,
  policy: ImportNetworkPolicy,
): Promise<{ bytes: number; contentType: string | null }> {
  let currentUrl = initialUrl;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const verified = await verifyDownloadUrl(currentUrl, policy);
    const result = await requestOnce(verified, tempPath, maxBytes);
    if (result.redirect) {
      currentUrl = result.redirect;
      continue;
    }
    return { bytes: result.bytes ?? 0, contentType: result.contentType ?? null };
  }
  throw new Error("Attachment download exceeded the redirect limit");
}

export function detectAttachmentMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]!) && bytes[3] === 0x04) return "application/zip";
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "application/gzip";
  return null;
}

async function hashAndProbe(path: string): Promise<{ hash: string; detectedMimeType: string | null }> {
  const handle = await open(path, "r");
  let detectedMimeType: string | null = null;
  try {
    const probe = Buffer.alloc(64);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    detectedMimeType = detectAttachmentMimeType(probe.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on("data", chunk => hash.update(chunk));
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
  });
  return { hash: hash.digest("hex"), detectedMimeType };
}

async function validateDestination(target: string, workspacePath: string, mode: LunaSandbox): Promise<void> {
  const targetParent = dirname(target);
  const parentRealPath = await realpath(targetParent);
  if (mode !== "danger-full-access") {
    const workspaceRealPath = await realpath(workspacePath);
    if (!isWithin(parentRealPath, workspaceRealPath)) {
      throw new Error(`Attachment destination resolves outside the disclosed workspace: ${target}`);
    }
  }
  try {
    const targetStat = await lstat(target);
    if (targetStat.isSymbolicLink()) throw new Error(`Refusing to import through a symbolic link: ${target}`);
    if (!targetStat.isFile()) throw new Error(`Attachment destination is not a regular file: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function validateParentBeforeCreate(target: string, workspacePath: string, mode: LunaSandbox): Promise<void> {
  if (mode === "danger-full-access") return;
  const workspaceRealPath = await realpath(workspacePath);
  let existingParent = dirname(target);
  while (true) {
    try {
      const existingRealPath = await realpath(existingParent);
      if (!isWithin(existingRealPath, workspaceRealPath)) {
        throw new Error(`Attachment destination resolves outside the disclosed workspace: ${target}`);
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(existingParent);
      if (next === existingParent) throw new Error(`Attachment destination parent could not be resolved: ${target}`);
      existingParent = next;
    }
  }
}

async function commitTempFile(tempPath: string, target: string, overwrite: boolean): Promise<boolean> {
  if (!overwrite) {
    try {
      await link(tempPath, target);
      await rm(tempPath, { force: true });
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new Error(`Destination already exists and overwrite=false: ${target}`);
      try {
        await copyFile(tempPath, target, fsConstants.COPYFILE_EXCL);
        await rm(tempPath, { force: true });
        return false;
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Destination already exists and overwrite=false: ${target}`);
        }
        throw copyError;
      }
    }
  }
  await rename(tempPath, target);
  return true;
}

export async function importChatGptAttachment(options: ImportOptions): Promise<AttachmentImportResult> {
  if (options.permissionMode === "read-only") throw new Error("Attachment imports are disabled in read-only mode");
  const reference = parseAttachmentReference(options.file);
  const destination = options.destination.trim();
  if (!destination) throw new Error("Attachment destination is required");
  const maxBytes = options.maxBytes ?? 20_000_000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 100_000_000) {
    throw new Error("Attachment maxBytes must be an integer between 1 and 100000000");
  }
  const expectedSha256 = options.expectedSha256?.trim().toLowerCase();
  if (expectedSha256 && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("expected_sha256 must be 64 hexadecimal characters");

  const workspaceInfo = await stat(options.workspacePath);
  if (!workspaceInfo.isDirectory()) throw new Error(`Disclosed workspace is not a directory: ${options.workspacePath}`);
  const target = resolveScopedPath(destination, options.workspacePath, options.permissionMode);
  const parent = dirname(target);
  await validateParentBeforeCreate(target, options.workspacePath, options.permissionMode);
  await mkdir(parent, { recursive: true });
  await validateDestination(target, options.workspacePath, options.permissionMode);

  const tempPath = resolve(parent, `.gpt-web-codex-import-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    const downloaded = await downloadAttachment(reference.download_url, tempPath, maxBytes, options.networkPolicy ?? {});
    await validateDestination(target, options.workspacePath, options.permissionMode);
    const tempRealPath = await realpath(tempPath);
    if (dirname(tempRealPath) !== await realpath(parent)) throw new Error("Attachment temporary file escaped its destination directory");

    const { hash, detectedMimeType } = await hashAndProbe(tempPath);
    if (expectedSha256 && hash !== expectedSha256) throw new Error(`Attachment SHA-256 mismatch for ${target}`);
    const declaredMimeType = reference.mime_type?.trim().toLowerCase() || downloaded.contentType;
    const mimeStatus = !declaredMimeType || !detectedMimeType
      ? "unknown"
      : declaredMimeType === detectedMimeType ? "matched" : "mismatched";
    const existedBefore = await lstat(target).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    await validateDestination(target, options.workspacePath, options.permissionMode);
    const replaced = await commitTempFile(tempPath, target, options.overwrite === true);
    return {
      path: target,
      bytes: downloaded.bytes,
      declared_mime_type: declaredMimeType ?? null,
      detected_mime_type: detectedMimeType,
      mime_type_status: mimeStatus,
      sha256: hash,
      verified: Boolean(expectedSha256),
      file_id: reference.file_id,
      file_name: reference.file_name ?? null,
      overwritten: existedBefore && replaced,
      warning: mimeStatus === "mismatched" ? "The declared and detected MIME types differ; the file was imported but was not executed." : null,
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
