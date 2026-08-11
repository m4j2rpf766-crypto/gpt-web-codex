import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { LunaSandbox } from "./types";
import { terminateOwnedProcessTree } from "./process-tree";

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

  read(path: string, workspace: string, mode: LunaSandbox, maxChars = 200_000): { path: string; text: string; truncated: boolean } {
    const target = resolveScopedPath(path, workspace, mode);
    const text = readFileSync(target, "utf8");
    return { path: target, text: text.slice(0, maxChars), truncated: text.length > maxChars };
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
