import { spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export function processRunning(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || pid! < 1) return false;
  try {
    process.kill(pid!, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function terminateOwnedProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!processRunning(pid)) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const result = spawnSync(join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true, timeout: 10_000,
    });
    if ((result.error || result.status !== 0) && processRunning(pid)) {
      throw new Error(`Could not terminate owned Windows process tree ${pid}`);
    }
    return;
  }
  try { process.kill(-pid!, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
