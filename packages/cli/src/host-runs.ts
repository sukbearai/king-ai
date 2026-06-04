import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOST_RUNS_PATH } from "./paths.js";
import type { HostRunSpecInput, JsonSafeHostLaunchPlan } from "./host-run-spec.js";
import { createHostLaunchPlan, formatHostLaunchPlanSummary, toJsonSafeHostLaunchPlan } from "./host-run-spec.js";

export type HostRunRequestStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface HostRunExecutorSpec {
  kind: "host-command";
  command: string;
  input?: unknown;
  format?: "text" | "json";
  actorRole?: string;
  trusted?: boolean;
}

export interface HostRunExecutionResult {
  command: string;
  ok: boolean;
  exitCode: number;
  textPreview?: string;
  error?: string;
}

export interface HostRunRequestUpdate {
  id: string;
  status: Exclude<HostRunRequestStatus, "pending">;
  updatedAt: string;
  detail?: string;
  result?: HostRunExecutionResult;
}

export interface HostRunRequest {
  id: string;
  status: HostRunRequestStatus;
  createdAt: string;
  updatedAt?: string;
  spec: HostRunSpecInput;
  ready: boolean;
  effectiveEngine?: "claude" | "codex";
  summary: string;
  detail?: string;
  executor?: HostRunExecutorSpec;
  result?: HostRunExecutionResult;
}

export interface HostRunSubmitInput extends HostRunSpecInput {
  requestId?: string;
  executor?: HostRunExecutorSpec;
}

export interface HostRunListInput {
  limit?: number;
  status?: HostRunRequestStatus;
}

export interface HostRunGetInput {
  id: string;
}

export interface HostRunUpdateInput {
  id: string;
  status: HostRunRequestUpdate["status"];
  detail?: string;
  result?: HostRunExecutionResult;
}

export interface HostRunSubmitResult {
  request: HostRunRequest;
  launchPlan: JsonSafeHostLaunchPlan;
  summary: string;
}

export interface HostRunUpdateResult {
  request: HostRunRequest;
  summary: string;
}

export async function submitHostRunRequest(
  input: HostRunSubmitInput,
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    availableEngines?: Array<"claude" | "codex">;
    now?: () => Date;
  } = {}
): Promise<HostRunSubmitResult> {
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const launchPlan = createHostLaunchPlan(input, options.env ?? process.env, options.availableEngines);
  const request: HostRunRequest = {
    id: cleanId(input.requestId) || launchPlan.runId,
    status: "pending",
    createdAt,
    spec: input,
    ready: launchPlan.ready,
    effectiveEngine: launchPlan.effectiveEngine,
    summary: formatHostLaunchPlanSummary(launchPlan),
    executor: normalizeExecutor(input.executor)
  };
  await appendHostRunRequest(request, options.path);
  return {
    request,
    launchPlan: toJsonSafeHostLaunchPlan(launchPlan),
    summary: formatHostRunRequestSummary(request)
  };
}

export async function listHostRunRequests(
  input: HostRunListInput = {},
  path = HOST_RUNS_PATH
): Promise<HostRunRequest[]> {
  const limit = normalizeLimit(input.limit);
  const requests = await readMergedHostRunRequests(path);
  const status = normalizeStatus(input.status, true);
  const filtered = status ? requests.filter((request) => request.status === status) : requests;
  return filtered.slice(-limit).reverse();
}

export async function getHostRunRequest(input: HostRunGetInput, path = HOST_RUNS_PATH): Promise<HostRunRequest | null> {
  const id = cleanRequiredId(input.id, "run request id");
  const requests = await readMergedHostRunRequests(path);
  return requests.find((request) => request.id === id) ?? null;
}

export async function updateHostRunRequest(
  input: HostRunUpdateInput,
  options: {
    path?: string;
    now?: () => Date;
  } = {}
): Promise<HostRunUpdateResult> {
  const id = cleanRequiredId(input.id, "run request id");
  const status = normalizeStatus(input.status, false) as HostRunRequestUpdate["status"];
  const existing = await getHostRunRequest({ id }, options.path);
  if (!existing) throw new Error(`host run request not found: ${id}`);
  const update: HostRunRequestUpdate = {
    id,
    status,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
    detail: cleanString(input.detail),
    result: normalizeExecutionResult(input.result)
  };
  await appendHostRunRecord(update, options.path);
  const request = applyHostRunUpdate(existing, update);
  return {
    request,
    summary: formatHostRunRequestSummary(request)
  };
}

export function formatHostRunRequests(requests: HostRunRequest[]): string {
  if (requests.length === 0) return "no host run requests";
  return requests.map(formatHostRunRequestSummary).join("\n\n");
}

export function formatHostRunRequestSummary(request: HostRunRequest): string {
  return [
    `host run request: ${request.id} ${request.status}`,
    `created: ${request.createdAt}`,
    request.updatedAt ? `updated: ${request.updatedAt}` : "",
    `ready: ${request.ready ? "yes" : "no"}`,
    `effective engine: ${request.effectiveEngine ?? "(none)"}`,
    request.detail ? `detail: ${request.detail}` : "",
    request.executor ? `executor: ${request.executor.kind} ${request.executor.command}` : "",
    request.result ? `result: ${request.result.command} ${request.result.ok ? "ok" : "failed"} exit=${request.result.exitCode}` : "",
    request.summary
  ].filter(Boolean).join("\n");
}

async function appendHostRunRequest(request: HostRunRequest, path = HOST_RUNS_PATH): Promise<void> {
  await appendHostRunRecord(request, path);
}

async function appendHostRunRecord(record: HostRunRequest | HostRunRequestUpdate, path = HOST_RUNS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

async function readMergedHostRunRequests(path = HOST_RUNS_PATH): Promise<HostRunRequest[]> {
  const text = await readFile(path, "utf8").catch((err: unknown) => {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") return "";
    throw err;
  });
  const byId = new Map<string, HostRunRequest>();
  for (const line of text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    const parsed = JSON.parse(line) as unknown;
    if (isHostRunRequest(parsed)) {
      byId.set(parsed.id, parsed);
      continue;
    }
    if (isHostRunRequestUpdate(parsed)) {
      const existing = byId.get(parsed.id);
      if (existing) byId.set(parsed.id, applyHostRunUpdate(existing, parsed));
    }
  }
  return [...byId.values()];
}

function applyHostRunUpdate(request: HostRunRequest, update: HostRunRequestUpdate): HostRunRequest {
  return {
    ...request,
    status: update.status,
    updatedAt: update.updatedAt,
    detail: update.detail ?? request.detail,
    result: update.result ?? request.result
  };
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return 20;
  const limit = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("host run request limit must be a positive integer");
  return Math.floor(limit);
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().replace(/[^a-zA-Z0-9_.:-]+/g, "-").slice(0, 80);
}

function cleanRequiredId(value: unknown, label: string): string {
  const id = cleanId(value);
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, 1000);
}

function normalizeExecutor(value: unknown): HostRunExecutorSpec | undefined {
  if (!value || typeof value !== "object") return undefined;
  const executor = value as HostRunExecutorSpec;
  if (executor.kind !== "host-command") return undefined;
  const command = cleanString(executor.command);
  if (!command) return undefined;
  return {
    kind: "host-command",
    command,
    input: executor.input,
    format: executor.format === "json" ? "json" : "text",
    actorRole: cleanString(executor.actorRole),
    trusted: executor.trusted === true
  };
}

function normalizeExecutionResult(value: unknown): HostRunExecutionResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result = value as HostRunExecutionResult;
  const command = cleanString(result.command);
  if (!command || typeof result.ok !== "boolean") return undefined;
  const exitCode = Number(result.exitCode);
  return {
    command,
    ok: result.ok,
    exitCode: Number.isFinite(exitCode) ? Math.floor(exitCode) : result.ok ? 0 : 1,
    textPreview: cleanString(result.textPreview),
    error: cleanString(result.error)
  };
}

function normalizeStatus(value: unknown, allowPending: boolean): HostRunRequestStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "pending" && allowPending) return value;
  if (value === "running" || value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error(`host run request status must be ${allowPending ? "pending, " : ""}running, completed, failed, or cancelled`);
}

function isHostRunRequest(value: unknown): value is HostRunRequest {
  return Boolean(value) &&
    typeof value === "object" &&
    typeof (value as HostRunRequest).id === "string" &&
    (value as HostRunRequest).status === "pending" &&
    typeof (value as HostRunRequest).createdAt === "string" &&
    typeof (value as HostRunRequest).ready === "boolean" &&
    typeof (value as HostRunRequest).summary === "string";
}

function isHostRunRequestUpdate(value: unknown): value is HostRunRequestUpdate {
  const status = (value as HostRunRequestUpdate | undefined)?.status;
  return Boolean(value) &&
    typeof value === "object" &&
    typeof (value as HostRunRequestUpdate).id === "string" &&
    typeof (value as HostRunRequestUpdate).updatedAt === "string" &&
    (status === "running" || status === "completed" || status === "failed" || status === "cancelled");
}
