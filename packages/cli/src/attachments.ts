import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CONFIG_DIR } from "./paths.js";

export type AttachmentKind = "image" | "file" | "audio" | "video" | "unknown";
export type AttachmentDecision = "accepted" | "rejected" | "skipped";

export interface RuntimeAttachmentInput {
  id?: string;
  name?: string;
  kind?: string;
  mime?: string;
  size?: number;
  sha256?: string;
  url?: string;
  filePath?: string;
  required?: boolean;
  source?: string;
}

export interface RuntimeAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  sha256?: string;
  url?: string;
  filePath?: string;
  source?: string;
  required: boolean;
  decision: AttachmentDecision;
  rejectionReason?: string;
  localPath?: string;
}

export interface AttachmentPolicy {
  maxCount: number;
  maxBytes: number;
  maxFileBytes: number;
  imageMaxBytes: number;
  allowedImageMimes: string[];
  allowedFileMimes: string[];
}

export const DEFAULT_ATTACHMENT_POLICY: AttachmentPolicy = {
  maxCount: 10,
  maxBytes: 100 * 1024 * 1024,
  maxFileBytes: 25 * 1024 * 1024,
  imageMaxBytes: 25 * 1024 * 1024,
  allowedImageMimes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  allowedFileMimes: [
    "application/javascript",
    "application/json",
    "application/pdf",
    "application/typescript",
    "application/zip",
    "text/css",
    "text/csv",
    "text/html",
    "text/javascript",
    "text/jsx",
    "text/markdown",
    "text/plain",
    "text/tsv",
    "text/tsx",
    "text/xml",
    "application/xml",
    "application/xhtml+xml"
  ]
};

const SAFE_EXT_BY_MIME: Record<string, string> = {
  "application/javascript": "js",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/typescript": "ts",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "text/css": "css",
  "text/csv": "csv",
  "text/html": "html",
  "text/javascript": "js",
  "text/jsx": "jsx",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/tsv": "tsv",
  "text/tsx": "tsx",
  "text/xml": "xml",
  "application/xml": "xml",
  "application/xhtml+xml": "html"
};

export function normalizeRuntimeAttachments(
  input: unknown,
  policy: Partial<AttachmentPolicy> = {}
): RuntimeAttachment[] {
  const merged = { ...DEFAULT_ATTACHMENT_POLICY, ...policy };
  const rows = Array.isArray(input) ? input : [];
  let acceptedCount = 0;
  let acceptedBytes = 0;
  return rows.map((row, index) => {
    const attachment = normalizeRuntimeAttachment(row, index);
    const rejection = attachmentDecision(attachment, merged, acceptedCount, acceptedBytes);
    if (rejection) {
      return { ...attachment, decision: rejection.decision, rejectionReason: rejection.reason };
    }
    acceptedCount += 1;
    acceptedBytes += attachment.size;
    return { ...attachment, decision: "accepted" };
  });
}

export function requiredAttachmentsRejected(attachments: readonly RuntimeAttachment[]): RuntimeAttachment[] {
  return attachments.filter((attachment) => attachment.required && attachment.decision !== "accepted");
}

export function formatAttachmentPrompt(attachments: readonly RuntimeAttachment[]): string {
  const accepted = attachments.filter((attachment) => attachment.decision === "accepted");
  const rejected = attachments.filter((attachment) => attachment.decision !== "accepted");
  const lines: string[] = [];
  if (accepted.length) {
    lines.push("Runtime attachments:");
    for (const attachment of accepted) {
      const location = attachment.localPath ?? attachment.filePath ?? attachment.url ?? "(unavailable)";
      const pathHint = attachment.localPath || attachment.filePath ? ` @${location}` : ` ${location}`;
      lines.push(`- [${attachment.name}] ${attachment.mime} ${attachment.size}B${pathHint}`);
    }
  }
  if (rejected.length) {
    lines.push("Rejected or skipped attachments:");
    for (const attachment of rejected) {
      lines.push(`- ${attachment.name}: ${attachment.rejectionReason ?? attachment.decision}`);
    }
  }
  return lines.join("\n");
}

export function mediaCacheDir(root = CONFIG_DIR): string {
  return join(root, "media");
}

export async function cacheLocalAttachment(
  attachment: RuntimeAttachment,
  root = mediaCacheDir()
): Promise<RuntimeAttachment> {
  if (attachment.decision !== "accepted") return attachment;
  if (attachment.filePath) return cacheFilePathAttachment(attachment, root);
  if (attachment.url) return cacheUrlAttachment(attachment, root);
  return attachment;
}

async function cacheFilePathAttachment(
  attachment: RuntimeAttachment,
  root: string
): Promise<RuntimeAttachment> {
  const filePath = attachment.filePath;
  if (!filePath) return attachment;
  const source = resolve(filePath);
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    return { ...attachment, decision: "rejected", rejectionReason: "not-a-file" };
  }
  const sha256 = attachment.sha256 ?? await hashFile(source);
  const ext = safeExtensionForMime(attachment.mime);
  const target = join(root, `${sha256}.${ext}`);
  await mkdir(root, { recursive: true });
  try {
    await stat(target);
  } catch {
    const tmp = join(root, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await copyByRename(source, tmp, target);
  }
  return {
    ...attachment,
    size: sourceStat.size,
    sha256,
    localPath: target
  };
}

async function cacheUrlAttachment(
  attachment: RuntimeAttachment,
  root: string
): Promise<RuntimeAttachment> {
  const url = parseDownloadUrl(attachment.url);
  if (!url) return { ...attachment, decision: "rejected", rejectionReason: "invalid-url" };
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) return { ...attachment, decision: "rejected", rejectionReason: `download-failed-${res.status}` };
  const contentType = res.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType && contentType !== attachment.mime) {
    return { ...attachment, decision: "rejected", rejectionReason: "mime-mismatch" };
  }
  const contentLength = Number(res.headers.get("Content-Length") ?? "");
  const maxBytes = attachment.kind === "image" ? DEFAULT_ATTACHMENT_POLICY.imageMaxBytes : DEFAULT_ATTACHMENT_POLICY.maxFileBytes;
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ...attachment, decision: "rejected", rejectionReason: "download-too-large" };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { ...attachment, decision: "rejected", rejectionReason: "download-too-large" };
  const expectedSize = attachment.size > 0 ? attachment.size : bytes.byteLength;
  if (bytes.byteLength !== expectedSize) {
    return { ...attachment, decision: "rejected", rejectionReason: "size-mismatch" };
  }
  const sha256 = hashBytes(bytes);
  if (attachment.sha256 && attachment.sha256 !== sha256) {
    return { ...attachment, decision: "rejected", rejectionReason: "sha256-mismatch" };
  }
  const ext = safeExtensionForMime(attachment.mime);
  const target = join(root, `${sha256}.${ext}`);
  await mkdir(root, { recursive: true });
  try {
    await stat(target);
  } catch {
    const tmp = join(root, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  }
  return {
    ...attachment,
    size: bytes.byteLength,
    sha256,
    localPath: target
  };
}

export async function cacheLocalAttachments(
  attachments: readonly RuntimeAttachment[],
  root = mediaCacheDir()
): Promise<RuntimeAttachment[]> {
  const out: RuntimeAttachment[] = [];
  for (const attachment of attachments) {
    out.push(await cacheLocalAttachment(attachment, root));
  }
  return out;
}

export async function gcMediaCache(root = mediaCacheDir(), maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const file of await listFiles(root)) {
    try {
      const info = await stat(file);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await rm(file, { force: true });
        removed += 1;
      }
    } catch {
      // Ignore files that disappear during GC.
    }
  }
  return removed;
}

function normalizeRuntimeAttachment(value: unknown, index: number): RuntimeAttachment {
  const row = value && typeof value === "object" ? value as RuntimeAttachmentInput : {};
  const name = cleanString(row.name) || (row.filePath ? basename(row.filePath) : `attachment-${index + 1}`);
  const mime = normalizeAttachmentMime(cleanString(row.mime), name);
  const kind = normalizeAttachmentKind(row.kind, mime);
  const size = Number.isFinite(row.size) && Number(row.size) > 0 ? Math.floor(Number(row.size)) : 0;
  return {
    id: cleanString(row.id) || `attachment-${index + 1}`,
    name,
    kind,
    mime,
    size,
    sha256: cleanString(row.sha256),
    url: cleanString(row.url),
    filePath: cleanString(row.filePath),
    source: cleanString(row.source),
    required: row.required === true,
    decision: "accepted"
  };
}

function attachmentDecision(
  attachment: RuntimeAttachment,
  policy: AttachmentPolicy,
  acceptedCount: number,
  acceptedBytes: number
): { decision: AttachmentDecision; reason: string } | null {
  if (!attachment.filePath && !attachment.url) return { decision: "rejected", reason: "missing-location" };
  if (attachment.kind === "audio" || attachment.kind === "video") return { decision: "skipped", reason: "unsupported-kind" };
  if (attachment.kind === "image" && !policy.allowedImageMimes.includes(attachment.mime)) return { decision: "rejected", reason: "unsupported-image-mime" };
  if (attachment.kind === "file" && !policy.allowedFileMimes.includes(attachment.mime)) return { decision: "rejected", reason: "unsupported-file-mime" };
  if (acceptedCount >= policy.maxCount) return { decision: "rejected", reason: "too-many-attachments" };
  if (attachment.size > policy.maxFileBytes) return { decision: "rejected", reason: "file-too-large" };
  if (attachment.kind === "image" && attachment.size > policy.imageMaxBytes) return { decision: "rejected", reason: "image-too-large" };
  if (acceptedBytes + attachment.size > policy.maxBytes) return { decision: "rejected", reason: "run-too-large" };
  return null;
}

function normalizeAttachmentKind(value: unknown, mime: string): AttachmentKind {
  if (value === "image" || value === "file" || value === "audio" || value === "video") return value;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime !== "application/octet-stream") return "file";
  return "unknown";
}

function safeExtensionForMime(mime: string): string {
  return SAFE_EXT_BY_MIME[mime] ?? "bin";
}

function normalizeAttachmentMime(value: string | undefined, name: string): string {
  const normalized = value?.toLowerCase() || "";
  if (normalized && normalized !== "application/octet-stream") return normalized;
  return mimeFromName(name) ?? (normalized || "application/octet-stream");
}

function mimeFromName(name: string): string | undefined {
  const ext = name.toLowerCase().split(".").pop();
  return ({
    css: "text/css",
    csv: "text/csv",
    htm: "text/html",
    html: "text/html",
    js: "text/javascript",
    json: "application/json",
    jsx: "text/jsx",
    md: "text/markdown",
    mjs: "text/javascript",
    ts: "application/typescript",
    tsx: "text/tsx",
    tsv: "text/tsv",
    txt: "text/plain",
    xhtml: "application/xhtml+xml",
    xml: "text/xml"
  } as Record<string, string | undefined>)[ext ?? ""];
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : undefined;
}

async function copyByRename(source: string, tmp: string, target: string): Promise<void> {
  const { copyFile } = await import("node:fs/promises");
  await copyFile(source, tmp);
  await rename(tmp, target);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseDownloadUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
