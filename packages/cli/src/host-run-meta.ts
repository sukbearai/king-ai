import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface HostRunMetaData {
  schema: "king.host-run-meta.v1";
  status: string;
  runId: string;
  goal?: string;
  preparedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  maxLoops?: number | "infinite";
  actualLoops?: number;
  detail?: string;
  command?: string;
  exitCode?: number;
  session?: Record<string, unknown>;
  paths?: Record<string, unknown>;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HostRunMetaReadInput {
  file?: string;
  outputDir?: string;
}

export interface HostRunMetaReadResult {
  file: string;
  meta: HostRunMetaData | null;
  exists: boolean;
}

export interface HostRunMetaUpdateInput extends HostRunMetaReadInput {
  runId: string;
  status: string;
  actualLoops?: number;
  detail?: string;
  command?: string;
  exitCode?: number;
  now?: () => Date;
}

export function hostRunMetaPathForOutputDir(outputDir: string): string {
  return join(resolve(outputDir), "meta.json");
}

export function resolveHostRunMetaPath(input: HostRunMetaReadInput = {}): string {
  if (input.file && input.file.trim()) return resolve(input.file);
  const outputDir = input.outputDir && input.outputDir.trim() ? input.outputDir : "deliverables";
  return hostRunMetaPathForOutputDir(outputDir);
}

export async function readHostRunMeta(input: HostRunMetaReadInput = {}): Promise<HostRunMetaReadResult> {
  const file = resolveHostRunMetaPath(input);
  const text = await readFile(file, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  });
  if (text === undefined) {
    return {
      file,
      meta: null,
      exists: false
    };
  }
  return {
    file,
    meta: parseHostRunMeta(text),
    exists: true
  };
}

export function formatHostRunMeta(result: HostRunMetaReadResult): string {
  if (!result.meta) return `host run meta: ${result.file}\nnot found`;
  return [
    `host run meta: ${result.file}`,
    `run: ${result.meta.runId}`,
    `status: ${result.meta.status}`,
    result.meta.goal ? `goal: ${result.meta.goal}` : "",
    result.meta.preparedAt ? `prepared: ${result.meta.preparedAt}` : "",
    result.meta.maxLoops !== undefined ? `loops: ${result.meta.actualLoops ?? 0}/${result.meta.maxLoops}` : ""
  ].filter(Boolean).join("\n");
}

export async function updateHostRunMeta(input: HostRunMetaUpdateInput): Promise<HostRunMetaReadResult> {
  const file = resolveHostRunMetaPath(input);
  const existing = await readHostRunMeta({ file });
  const now = (input.now ?? (() => new Date()))().toISOString();
  const base: HostRunMetaData = existing.meta ?? {
    schema: "king.host-run-meta.v1",
    status: input.status,
    runId: input.runId
  };
  const next: HostRunMetaData = {
    ...base,
    schema: "king.host-run-meta.v1",
    runId: base.runId || input.runId,
    status: cleanString(input.status) ?? base.status,
    updatedAt: now,
    actualLoops: input.actualLoops !== undefined ? Math.max(0, Math.floor(input.actualLoops)) : base.actualLoops,
    detail: cleanString(input.detail) ?? base.detail,
    command: cleanString(input.command) ?? base.command,
    exitCode: normalizeExitCode(input.exitCode) ?? base.exitCode,
    completedAt: isTerminalStatus(input.status) ? now : base.completedAt
  };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(dropUndefined({ ...next }), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return {
    file,
    meta: next,
    exists: true
  };
}

function parseHostRunMeta(text: string): HostRunMetaData | null {
  try {
    const parsed = JSON.parse(text) as Partial<HostRunMetaData>;
    if (!parsed || parsed.schema !== "king.host-run-meta.v1" || typeof parsed.runId !== "string") return null;
    return {
      ...parsed,
      schema: "king.host-run-meta.v1",
      status: typeof parsed.status === "string" ? parsed.status : "",
      runId: parsed.runId,
      goal: typeof parsed.goal === "string" ? parsed.goal : undefined,
      preparedAt: typeof parsed.preparedAt === "string" ? parsed.preparedAt : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      maxLoops: parsed.maxLoops === "infinite" || typeof parsed.maxLoops === "number" ? parsed.maxLoops : undefined,
      actualLoops: typeof parsed.actualLoops === "number" ? parsed.actualLoops : undefined,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
      command: typeof parsed.command === "string" ? parsed.command : undefined,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
      session: parsed.session && typeof parsed.session === "object" ? parsed.session as Record<string, unknown> : undefined,
      paths: parsed.paths && typeof parsed.paths === "object" ? parsed.paths as Record<string, unknown> : undefined,
      config: parsed.config && typeof parsed.config === "object" ? parsed.config as Record<string, unknown> : undefined
    };
  } catch {
    return null;
  }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : undefined;
}

function normalizeExitCode(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function isTerminalStatus(value: unknown): boolean {
  return value === "completed" || value === "failed" || value === "cancelled";
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
