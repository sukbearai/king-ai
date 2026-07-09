import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cacheLocalAttachments,
  formatAttachmentPrompt,
  normalizeRuntimeAttachments,
  requiredAttachmentsRejected,
} from "../src/attachments.js";

test("normalizeRuntimeAttachments accepts images and rejects required invalid files", () => {
  const attachments = normalizeRuntimeAttachments([
    { name: "screenshot.png", mime: "image/png", size: 12, filePath: "/tmp/screenshot.png", required: true },
    { name: "binary.exe", mime: "application/x-msdownload", size: 10, filePath: "/tmp/binary.exe", required: true },
  ]);
  assert.equal(attachments[0]?.decision, "accepted");
  assert.equal(attachments[1]?.decision, "rejected");
  assert.equal(attachments[1]?.rejectionReason, "unsupported-file-mime");
  assert.deepEqual(
    requiredAttachmentsRejected(attachments).map((item) => item.name),
    ["binary.exe"],
  );
  assert.match(formatAttachmentPrompt(attachments), /\[screenshot\.png\]/);
  assert.match(formatAttachmentPrompt(attachments), /@\/tmp\/screenshot\.png/);
  assert.match(formatAttachmentPrompt(attachments), /binary\.exe: unsupported-file-mime/);
});

test("normalizeRuntimeAttachments accepts readable text and source files", () => {
  const attachments = normalizeRuntimeAttachments([
    { name: "prototype.html", mime: "text/html", size: 120, url: "https://example.com/prototype.html", required: true },
    {
      name: "fallback.html",
      mime: "application/octet-stream",
      size: 80,
      url: "https://example.com/fallback.html",
      required: true,
    },
    { name: "component.tsx", mime: "text/tsx", size: 60, filePath: "/tmp/component.tsx" },
  ]);
  assert.equal(attachments[0]?.decision, "accepted");
  assert.equal(attachments[0]?.mime, "text/html");
  assert.equal(attachments[1]?.decision, "accepted");
  assert.equal(attachments[1]?.mime, "text/html");
  assert.equal(attachments[2]?.decision, "accepted");
  assert.match(formatAttachmentPrompt(attachments), /\[prototype\.html\] text\/html 120B/);
});

test("cacheLocalAttachments copies accepted file attachments into media cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-attachments-"));
  const source = join(dir, "note.txt");
  const cache = join(dir, "cache");
  await mkdir(cache, { recursive: true });
  await writeFile(source, "hello", "utf8");
  const [attachment] = await cacheLocalAttachments(
    normalizeRuntimeAttachments([{ name: "note.txt", mime: "text/plain", size: 5, filePath: source }]),
    cache,
  );
  assert.equal(attachment?.decision, "accepted");
  assert.ok(attachment?.localPath?.startsWith(cache));
  assert.equal(await readFile(attachment?.localPath ?? "", "utf8"), "hello");
});

test("cacheLocalAttachments downloads accepted URL attachments into media cache", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-url-attachments-"));
  const cache = join(dir, "cache");
  const server = createServer((req, res) => {
    if (req.url !== "/screen.png") {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end("png");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const [attachment] = await cacheLocalAttachments(
      normalizeRuntimeAttachments([
        { name: "screen.png", mime: "image/png", size: 3, url: `http://127.0.0.1:${address.port}/screen.png` },
      ]),
      cache,
    );

    assert.equal(attachment?.decision, "accepted");
    assert.ok(attachment?.localPath?.startsWith(cache));
    assert.equal(await readFile(attachment?.localPath ?? "", "utf8"), "png");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
