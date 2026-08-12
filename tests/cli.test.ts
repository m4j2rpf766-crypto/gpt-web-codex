import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function runCli(args: string[], env = process.env) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../src/cli.ts"), ...args], {
    env, stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("public CLI describes only the standalone GPT Web Codex surface", async () => {
  const result = await runCli(["--help"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("gpt-web-codex");
  expect(result.stdout).toContain("standalone Luna execution");
  for (const retired of [" serve", " service ", " route", "uninstall", "Responses port"]) {
    expect(result.stdout).not.toContain(retired);
  }
});

test("retired route and Responses commands cannot be invoked", async () => {
  for (const command of ["route", "serve", "service", "uninstall"]) {
    const result = await runCli([command]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Unknown command: ${command}`);
  }
});

test("launcher-controlled login fails before opening Chrome without live authorization", async () => {
  const root = mkdtempSync(join(tmpdir(), "gpt-web-codex-cli-login-"));
  const statePath = join(root, "storage-state.json");
  try {
    const result = await runCli([
      "login", "--launcher-control", "--chrome", process.execPath, "--storage-state", statePath,
    ], {
      ...process.env,
      CODEX_CHATGPT_WEB_HOME: join(root, "app"),
      CODEX_CHATGPT_WEB_BROWSER_HOST_DESCRIPTOR: undefined,
      CODEX_WEB_GPT_LAUNCHER_CONTROL_TOKEN: undefined,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("requires a live launcher authorization");
    expect(existsSync(statePath)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
