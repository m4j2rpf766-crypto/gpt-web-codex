import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import type { LunaSandbox } from "./types";
import { terminateOwnedProcessTree } from "./process-tree";

const MAX_DIRECT_IMAGE_BYTES = 20_000_000;
const MAX_SOURCE_IMAGE_BYTES = 50_000_000;
const MODEL_IMAGE_MAX_DIMENSION = 1_600;

export interface DirectTextFileRead {
  path: string;
  text: string;
  truncated: boolean;
}

export interface DirectImageFileRead {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
  bytes: number;
  optimized?: boolean;
  sourceBytes?: number;
  sourceMimeType?: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width?: number;
  height?: number;
}

function imageMimeType(bytes: Buffer): DirectImageFileRead["mimeType"] | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

interface TerminalJob {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "failed" | "cancelled";
  pid?: number;
  exitCode?: number | null;
  output: string;
  startedAt: string;
  finishedAt?: string;
  child?: ChildProcessWithoutNullStreams;
}

function within(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function resolveScopedPath(path: string, workspace: string, mode: LunaSandbox): string {
  const target = resolve(workspace, path);
  if (mode !== "danger-full-access" && !within(target, workspace)) {
    throw new Error(`Path is outside the disclosed workspace: ${target}`);
  }
  return target;
}

export class DirectToolService {
  private readonly terminals = new Map<string, TerminalJob>();

  shutdown(): void {
    for (const job of this.terminals.values()) {
      if (job.status !== "running" || !job.child) continue;
      try { terminateOwnedProcessTree(job.child); } catch {}
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      delete job.child;
    }
  }

  read(path: string, workspace: string, mode: LunaSandbox, maxChars = 200_000, maxImageBytes = 10_000_000): DirectTextFileRead | DirectImageFileRead {
    const target = resolveScopedPath(path, workspace, mode);
    const bytes = readFileSync(target);
    const mimeType = imageMimeType(bytes);
    if (mimeType) {
      const limit = Math.min(Math.max(1, maxImageBytes), MAX_DIRECT_IMAGE_BYTES);
      if (bytes.length > limit) {
        throw new Error(`Image exceeds the ${limit}-byte MCP transfer limit: ${target}`);
      }
      return { path: target, mimeType, data: bytes.toString("base64"), bytes: bytes.length };
    }
    const text = bytes.toString("utf8");
    return { path: target, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  async readForTransfer(
    path: string,
    workspace: string,
    mode: LunaSandbox,
    maxChars = 200_000,
    maxImageBytes = 1_500_000,
  ): Promise<DirectTextFileRead | DirectImageFileRead> {
    const target = resolveScopedPath(path, workspace, mode);
    const source = readFileSync(target);
    const sourceMimeType = imageMimeType(source);
    if (!sourceMimeType) {
      const text = source.toString("utf8");
      return { path: target, text: text.slice(0, maxChars), truncated: text.length > maxChars };
    }
    if (source.length > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`Image exceeds the ${MAX_SOURCE_IMAGE_BYTES}-byte local decode limit: ${target}`);
    }
    const limit = Math.min(Math.max(1, maxImageBytes), MAX_DIRECT_IMAGE_BYTES);
    const metadata = await sharp(source, { animated: false }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (source.length <= limit && width <= MODEL_IMAGE_MAX_DIMENSION && height <= MODEL_IMAGE_MAX_DIMENSION) {
      return { path: target, mimeType: sourceMimeType, data: source.toString("base64"), bytes: source.length, width, height };
    }

    let best: { bytes: Buffer; width: number; height: number } | undefined;
    for (const dimension of [1_600, 1_280, 1_024, 768, 512]) {
      for (const quality of [82, 72, 62]) {
        const transformed = await sharp(source, { animated: false })
          .rotate()
          .resize({ width: dimension, height: dimension, fit: "inside", withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        if (!best || transformed.data.length < best.bytes.length) {
          best = { bytes: transformed.data, width: transformed.info.width, height: transformed.info.height };
        }
        if (transformed.data.length <= limit) {
          return {
            path: target,
            mimeType: "image/webp",
            data: transformed.data.toString("base64"),
            bytes: transformed.data.length,
            optimized: true,
            sourceBytes: source.length,
            sourceMimeType,
            width: transformed.info.width,
            height: transformed.info.height,
          };
        }
      }
    }
    throw new Error(`Image could not be reduced below the ${limit}-byte MCP transfer limit: ${target} (smallest ${best?.bytes.length ?? source.length} bytes)`);
  }

  list(path: string, workspace: string, mode: LunaSandbox): { path: string; entries: Array<{ name: string; kind: string; size?: number }> } {
    const target = resolveScopedPath(path, workspace, mode);
    const entries = readdirSync(target, { withFileTypes: true }).map(entry => {
      const kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
      const size = entry.isFile() ? statSync(resolve(target, entry.name)).size : undefined;
      return { name: entry.name, kind, ...(size === undefined ? {} : { size }) };
    });
    return { path: target, entries };
  }

  search(query: string, path: string, workspace: string, mode: LunaSandbox, maxResults = 200): {
    path: string; matches: Array<{ path: string; line: number; text: string }>; truncated: boolean;
  } {
    const root = resolveScopedPath(path, workspace, mode);
    const needle = query.toLowerCase();
    if (!needle) throw new Error("query is required");
    const matches: Array<{ path: string; line: number; text: string }> = [];
    const pending = [root];
    let truncated = false;
    while (pending.length > 0 && !truncated) {
      const current = pending.pop()!;
      const stat = statSync(current);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (entry.isDirectory() && [".git", "node_modules", ".local"].includes(entry.name)) continue;
          pending.push(resolve(current, entry.name));
        }
        continue;
      }
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      let text: string;
      try { text = readFileSync(current, "utf8"); } catch { continue; }
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.toLowerCase().includes(needle)) continue;
        matches.push({ path: current, line: index + 1, text: line.slice(0, 2_000) });
        if (matches.length >= maxResults) { truncated = true; break; }
      }
    }
    return { path: root, matches, truncated };
  }

  write(path: string, content: string, workspace: string, mode: LunaSandbox): { path: string; bytes: number } {
    if (mode === "read-only") throw new Error("File writes are disabled in read-only mode");
    const target = resolveScopedPath(path, workspace, mode);
    writeFileSync(target, content, "utf8");
    return { path: target, bytes: Buffer.byteLength(content) };
  }

  startTerminal(command: string, cwd: string, workspace: string, mode: LunaSandbox): Omit<TerminalJob, "child"> {
    if (mode === "read-only") throw new Error("Terminal execution is disabled in read-only mode");
    const resolvedCwd = resolveScopedPath(cwd, workspace, mode);
    const id = randomUUID();
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-lc", command];
    const child = spawn(shell, args, { cwd: resolvedCwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const job: TerminalJob = {
      id, command, cwd: resolvedCwd, status: "running", pid: child.pid, output: "", startedAt: new Date().toISOString(), child,
    };
    const collect = (chunk: Buffer) => { job.output = `${job.output}${chunk.toString("utf8")}`.slice(-1_000_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", error => {
      job.output = `${job.output}\n${error.message}`.trim();
      job.status = "failed";
      job.finishedAt = new Date().toISOString();
    });
    child.once("close", code => {
      if (job.status === "running") job.status = code === 0 ? "completed" : "failed";
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      delete job.child;
    });
    this.terminals.set(id, job);
    return this.publicTerminal(job);
  }

  terminal(jobId: string): Omit<TerminalJob, "child"> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    return this.publicTerminal(job);
  }

  cancelTerminal(jobId: string): Omit<TerminalJob, "child"> {
    const job = this.terminals.get(jobId);
    if (!job) throw new Error(`Unknown terminal job: ${jobId}`);
    if (job.status === "running") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
      if (job.child) {
        const child = job.child;
        child.kill("SIGTERM");
        setTimeout(() => { try { terminateOwnedProcessTree(child); } catch {} }, 5_000).unref?.();
      }
    }
    return this.publicTerminal(job);
  }

  private publicTerminal({ child: _child, ...job }: TerminalJob): Omit<TerminalJob, "child"> {
    return { ...job };
  }
}
