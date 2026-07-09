import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type HostRunHeartbeatStatus = "prepared" | "running" | "completed" | "failed" | "cancelled";

export interface HostRunHeartbeatData {
  schema: "king-ai.host-run-heartbeat.v1";
  status: HostRunHeartbeatStatus;
  runId: string;
  lastTick: string;
  updatedAt: string;
  loopCount: number;
  outputDir?: string;
  pid?: number;
  detail?: string;
  command?: string;
  exitCode?: number;
}

export interface HostRunHeartbeatInput {
  path: string;
  runId: string;
  status: HostRunHeartbeatStatus;
  outputDir?: string;
  loopCount?: number;
  pid?: number;
  detail?: string;
  command?: string;
  exitCode?: number;
  now?: () => Date;
}

export interface HostRunHeartbeatReadInput {
  file?: string;
  outputDir?: string;
}

export interface HostRunHeartbeatReadResult {
  file: string;
  heartbeat: HostRunHeartbeatData | null;
  exists: boolean;
}

export function hostRunHeartbeatPathForOutputDir(outputDir: string): string {
  return join(resolve(outputDir), ".king-ai", "heartbeat.json");
}

export function resolveHostRunHeartbeatPath(input: HostRunHeartbeatReadInput = {}): string {
  if (input.file && input.file.trim()) return resolve(input.file);
  const outputDir = input.outputDir && input.outputDir.trim() ? input.outputDir : "deliverables";
  return hostRunHeartbeatPathForOutputDir(outputDir);
}

export async function readHostRunHeartbeat(input: HostRunHeartbeatReadInput = {}): Promise<HostRunHeartbeatReadResult> {
  const file = resolveHostRunHeartbeatPath(input);
  const text = await readFile(file, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT")
      return undefined;
    throw err;
  });
  if (text === undefined) {
    return {
      file,
      heartbeat: null,
      exists: false,
    };
  }
  return {
    file,
    heartbeat: parseHostRunHeartbeat(text),
    exists: true,
  };
}

export function formatHostRunHeartbeat(result: HostRunHeartbeatReadResult): string {
  if (!result.heartbeat) return `host run heartbeat: ${result.file}\nnot found`;
  return [
    `host run heartbeat: ${result.file}`,
    `run: ${result.heartbeat.runId}`,
    `status: ${result.heartbeat.status}`,
    `last tick: ${result.heartbeat.lastTick}`,
    `loops: ${result.heartbeat.loopCount}`,
    result.heartbeat.command
      ? `command: ${result.heartbeat.command}${result.heartbeat.exitCode !== undefined ? ` exit=${result.heartbeat.exitCode}` : ""}`
      : "",
    result.heartbeat.detail ? `detail: ${result.heartbeat.detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function writeHostRunHeartbeat(input: HostRunHeartbeatInput): Promise<HostRunHeartbeatData> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const data: HostRunHeartbeatData = {
    schema: "king-ai.host-run-heartbeat.v1",
    status: input.status,
    runId: input.runId,
    lastTick: now,
    updatedAt: now,
    loopCount: Math.max(0, Math.floor(input.loopCount ?? 0)),
    outputDir: input.outputDir,
    pid: input.pid,
    detail: cleanString(input.detail),
    command: cleanString(input.command),
    exitCode: normalizeExitCode(input.exitCode),
  };
  await mkdir(dirname(input.path), { recursive: true });
  await writeFile(input.path, `${JSON.stringify(dropUndefined({ ...data }), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return data;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1000) : undefined;
}

function normalizeExitCode(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) : undefined;
}

function parseHostRunHeartbeat(text: string): HostRunHeartbeatData | null {
  try {
    const parsed = JSON.parse(text) as Partial<HostRunHeartbeatData>;
    if (!parsed || parsed.schema !== "king-ai.host-run-heartbeat.v1" || typeof parsed.runId !== "string") return null;
    if (!isHostRunHeartbeatStatus(parsed.status)) return null;
    return {
      schema: "king-ai.host-run-heartbeat.v1",
      status: parsed.status,
      runId: parsed.runId,
      lastTick: typeof parsed.lastTick === "string" ? parsed.lastTick : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      loopCount: typeof parsed.loopCount === "number" ? parsed.loopCount : 0,
      outputDir: typeof parsed.outputDir === "string" ? parsed.outputDir : undefined,
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      detail: typeof parsed.detail === "string" ? parsed.detail : undefined,
      command: typeof parsed.command === "string" ? parsed.command : undefined,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : undefined,
    };
  } catch {
    return null;
  }
}

function isHostRunHeartbeatStatus(value: unknown): value is HostRunHeartbeatStatus {
  return (
    value === "prepared" || value === "running" || value === "completed" || value === "failed" || value === "cancelled"
  );
}

function dropUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
