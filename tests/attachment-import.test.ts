import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectAttachmentMimeType,
  importChatGptAttachment,
  parseAttachmentReference,
} from "../src/standalone/attachment-import";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "gpt-web-codex-import-test-"));
  roots.push(root);
  return root;
}

async function fixtureServer(body: Buffer, options: { redirect?: string; chunked?: boolean } = {}) {
  const server = http.createServer((_request, response) => {
    if (options.redirect) {
      response.writeHead(302, { Location: options.redirect });
      response.end();
      return;
    }
    response.writeHead(200, options.chunked ? { "Content-Type": "image/png" } : {
      "Content-Type": "image/png",
      "Content-Length": String(body.length),
    });
    if (options.chunked) {
      response.write(body.subarray(0, Math.ceil(body.length / 2)));
      response.end(body.subarray(Math.ceil(body.length / 2)));
    } else {
      response.end(body);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}/attachment`,
    localhostUrl: `http://localhost:${address.port}/attachment`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const loopbackPolicy = { allowHttpLoopback: true } as const;

test("attachment references require a platform file object", () => {
  expect(() => parseAttachmentReference("file_123")).toThrow("attachment object");
  expect(() => parseAttachmentReference({ file_id: "file_123" })).toThrow("download_url");
  expect(() => parseAttachmentReference({ file_id: "file_123", download_url: "data:text/plain,test" })).toThrow("scheme");
  expect(parseAttachmentReference({
    file_id: "file_123", download_url: "https://files.oaiusercontent.com/file", file_name: "pixel.png",
  })).toMatchObject({ file_id: "file_123", file_name: "pixel.png" });
});

test("attachment magic-byte detection is independent from declared MIME", () => {
  expect(detectAttachmentMimeType(png)).toBe("image/png");
  expect(detectAttachmentMimeType(Buffer.from("%PDF-1.7\n"))).toBe("application/pdf");
  expect(detectAttachmentMimeType(Buffer.from("plain text"))).toBeNull();
});

test("imports an attachment into the workspace and returns bounded metadata", async () => {
  const root = workspace();
  const fixture = await fixtureServer(png);
  try {
    const expectedHash = createHash("sha256").update(png).digest("hex");
    const result = await importChatGptAttachment({
      file: {
        download_url: fixture.url,
        file_id: "file_pixel",
        mime_type: "image/png",
        file_name: "pixel.png",
      },
      destination: "attachments/pixel.png",
      workspacePath: root,
      permissionMode: "workspace-write",
      expectedSha256: expectedHash,
      networkPolicy: loopbackPolicy,
    });
    expect(readFileSync(join(root, "attachments", "pixel.png"))).toEqual(png);
    expect(result).toEqual({
      path: join(root, "attachments", "pixel.png"),
      bytes: png.length,
      declared_mime_type: "image/png",
      detected_mime_type: "image/png",
      mime_type_status: "matched",
      sha256: expectedHash,
      verified: true,
      file_id: "file_pixel",
      file_name: "pixel.png",
      overwritten: false,
      warning: null,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.url);
    expect(readdirSync(join(root, "attachments")).some(name => name.startsWith(".gpt-web-codex-import-"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("read-only and paths outside workspace are rejected before download", async () => {
  const root = workspace();
  const file = { download_url: "https://files.oaiusercontent.com/unused", file_id: "file_unused" };
  await expect(importChatGptAttachment({
    file, destination: "blocked.txt", workspacePath: root, permissionMode: "read-only",
  })).rejects.toThrow("read-only");
  await expect(importChatGptAttachment({
    file, destination: "../outside.txt", workspacePath: root, permissionMode: "workspace-write",
  })).rejects.toThrow("outside the disclosed workspace");
  expect(existsSync(join(root, "..", "outside.txt"))).toBe(false);
});

test("does not overwrite by default and overwrite replacement stays in the destination directory", async () => {
  const root = workspace();
  const target = join(root, "pixel.png");
  writeFileSync(target, "old");
  const fixture = await fixtureServer(png);
  const input = {
    file: { download_url: fixture.url, file_id: "file_pixel", mime_type: "image/png" },
    destination: "pixel.png",
    workspacePath: root,
    permissionMode: "workspace-write" as const,
    networkPolicy: loopbackPolicy,
  };
  try {
    await expect(importChatGptAttachment(input)).rejects.toThrow("overwrite=false");
    expect(readFileSync(target, "utf8")).toBe("old");
    const overwritten = await importChatGptAttachment({ ...input, overwrite: true });
    expect(overwritten.overwritten).toBe(true);
    expect(readFileSync(target)).toEqual(png);
    expect(readdirSync(root).some(name => name.startsWith(".gpt-web-codex-import-"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("full access permits an explicit destination outside the workspace", async () => {
  const root = workspace();
  const outside = workspace();
  const target = join(outside, "full-access.png");
  const fixture = await fixtureServer(png);
  try {
    const result = await importChatGptAttachment({
      file: { download_url: fixture.url, file_id: "file_full_access" },
      destination: target,
      workspacePath: root,
      permissionMode: "danger-full-access",
      networkPolicy: loopbackPolicy,
    });
    expect(result.path).toBe(target);
    expect(readFileSync(target)).toEqual(png);
  } finally {
    await fixture.close();
  }
});

test("hash mismatch leaves neither destination nor temporary file", async () => {
  const root = workspace();
  const fixture = await fixtureServer(png);
  try {
    await expect(importChatGptAttachment({
      file: { download_url: fixture.url, file_id: "file_wrong_hash" },
      destination: "wrong-hash.png",
      workspacePath: root,
      permissionMode: "workspace-write",
      expectedSha256: "0".repeat(64),
      networkPolicy: loopbackPolicy,
    })).rejects.toThrow("SHA-256 mismatch");
    expect(existsSync(join(root, "wrong-hash.png"))).toBe(false);
    expect(readdirSync(root).some(name => name.startsWith(".gpt-web-codex-import-"))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("reports MIME mismatch without executing or embedding the file", async () => {
  const root = workspace();
  const fixture = await fixtureServer(png);
  try {
    const result = await importChatGptAttachment({
      file: { download_url: fixture.url, file_id: "file_mismatch", mime_type: "application/zip" },
      destination: "mismatch.bin",
      workspacePath: root,
      permissionMode: "workspace-write",
      networkPolicy: loopbackPolicy,
    });
    expect(result.mime_type_status).toBe("mismatched");
    expect(result.warning).toContain("not executed");
  } finally {
    await fixture.close();
  }
});

test("redirects are revalidated and streamed size failures remove partial files", async () => {
  const root = workspace();
  const destination = await fixtureServer(png);
  const redirect = await fixtureServer(Buffer.alloc(0), { redirect: destination.url });
  const unsafeRedirect = await fixtureServer(Buffer.alloc(0), { redirect: "https://example.com/file" });
  const oversized = await fixtureServer(Buffer.alloc(128, 1), { chunked: true });
  try {
    const imported = await importChatGptAttachment({
      file: { download_url: redirect.url, file_id: "file_redirect" },
      destination: "redirected.png",
      workspacePath: root,
      permissionMode: "workspace-write",
      networkPolicy: loopbackPolicy,
    });
    expect(imported.detected_mime_type).toBe("image/png");

    await expect(importChatGptAttachment({
      file: { download_url: oversized.url, file_id: "file_large" },
      destination: "too-large.bin",
      workspacePath: root,
      permissionMode: "workspace-write",
      maxBytes: 64,
      networkPolicy: loopbackPolicy,
    })).rejects.toThrow("exceeded");
    expect(existsSync(join(root, "too-large.bin"))).toBe(false);
    expect(readdirSync(root).some(name => name.startsWith(".gpt-web-codex-import-"))).toBe(false);

    await expect(importChatGptAttachment({
      file: { download_url: unsafeRedirect.url, file_id: "file_bad_redirect" },
      destination: "bad-redirect.bin",
      workspacePath: root,
      permissionMode: "workspace-write",
      networkPolicy: loopbackPolicy,
    })).rejects.toThrow("approved ChatGPT file origin");
  } finally {
    await redirect.close();
    await unsafeRedirect.close();
    await destination.close();
    await oversized.close();
  }
});

test("pins the validated DNS result used by the actual request", async () => {
  const root = workspace();
  const fixture = await fixtureServer(png);
  try {
    const result = await importChatGptAttachment({
      file: { download_url: fixture.localhostUrl, file_id: "file_dns_pin", mime_type: "image/png" },
      destination: "dns-pin.png",
      workspacePath: root,
      permissionMode: "workspace-write",
      networkPolicy: loopbackPolicy,
    });
    expect(result.detected_mime_type).toBe("image/png");
  } finally {
    await fixture.close();
  }
});

test("unapproved hosts and loopback are rejected by production policy", async () => {
  const root = workspace();
  await expect(importChatGptAttachment({
    file: { download_url: "https://example.com/file", file_id: "file_bad_host" },
    destination: "bad.bin", workspacePath: root, permissionMode: "workspace-write",
  })).rejects.toThrow("approved ChatGPT file origin");
  await expect(importChatGptAttachment({
    file: { download_url: "http://127.0.0.1/file", file_id: "file_loopback" },
    destination: "bad.bin", workspacePath: root, permissionMode: "workspace-write",
  })).rejects.toThrow("HTTPS");
});
