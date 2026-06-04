import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { buildHostStatusSnapshot, formatHostStatusSnapshot } from "./host-api.js";
import { executeNextHostRunRequest, listSafeHostExecutorCommands } from "./host-run-executor.js";
import { listHostCommands, runHostCommand } from "./host-control.js";
import type { HostCommandRequest, HostCommandResult } from "./host-control.js";
import { readHostRunHeartbeat } from "./host-run-heartbeat.js";
import { readHostRunMeta } from "./host-run-meta.js";
import { readHostTimeline } from "./host-timeline.js";
import type { HostTimelineEvent } from "./host-timeline.js";
import { listHostRunRequests } from "./host-runs.js";
import type { HostRunListInput, HostRunRequest } from "./host-runs.js";
import { readRunningState } from "./service.js";
import type { RunningState } from "./service.js";
import { tokenBudgetFromEnv, usagePricingFromEnv } from "./usage.js";
import type { UsagePricingRule } from "./usage.js";

export const DEFAULT_HOST_SERVER_HOST = "127.0.0.1";
export const DEFAULT_HOST_SERVER_PORT = 8799;

const HOST_RESOURCE_ENDPOINTS = [
  "GET /health",
  "GET /capabilities",
  "GET /status",
  "GET /host/snapshot",
  "GET /host/stream",
  "GET /status/stream",
  "GET /status.txt",
  "GET /events",
  "GET /timeline",
  "GET /timeline/stream",
  "GET /usage",
  "GET /expenses",
  "GET /doctor",
  "GET /commands",
  "POST /commands/run",
  "POST /runs/plan",
  "POST /runs/preflight",
  "POST /runs/prepare-layout",
  "GET /runs",
  "GET /runs/stream",
  "POST /runs",
  "GET /runs/:id",
  "GET /runs/:id/stream",
  "PATCH /runs/:id",
  "DELETE /runs/:id",
  "POST /runs/:id/execute",
  "GET /runs/:id/events",
  "POST /runs/:id/events",
  "GET /runs/:id/results",
  "GET /runs/:id/heartbeat",
  "GET /runs/:id/meta",
  "POST /runs/execute",
  "POST /exports/plan",
  "POST /exports",
  "GET /policy/:command",
  "POST /policy/:command"
];

const HOST_STREAM_ENDPOINTS = [
  "GET /host/stream",
  "GET /status/stream",
  "GET /timeline/stream",
  "GET /runs/stream",
  "GET /runs/:id/stream"
];

export type HostStatusServerOptions = {
  host?: string;
  port?: number;
  readState?: () => Promise<RunningState | null>;
  tokenBudget?: () => number | null | undefined;
  usagePricing?: () => UsagePricingRule[];
  readTimeline?: (limit?: number) => Promise<HostTimelineEvent[]>;
  readRuns?: (input?: HostRunListInput) => Promise<HostRunRequest[]>;
  runCommand?: (request: HostCommandRequest) => Promise<HostCommandResult>;
  executeRuns?: boolean;
  executeRunsIntervalMs?: number;
  statusStreamIntervalMs?: number;
};

export function hostServerPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KING_HOST_PORT;
  if (!raw) return DEFAULT_HOST_SERVER_PORT;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    throw new Error("host server port must be between 0 and 65535");
  }
  return port;
}

export function normalizeHostServerHost(host = DEFAULT_HOST_SERVER_HOST): string {
  const value = host.trim();
  if (value === "127.0.0.1" || value === "::1" || value === "localhost") return value;
  throw new Error("host server only supports localhost bindings: 127.0.0.1, ::1, or localhost");
}

function localhostCorsOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return undefined;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]") return origin;
  } catch {
    return undefined;
  }
  return undefined;
}

function hostResponseHeaders(req?: IncomingMessage, headers: Record<string, string | number> = {}): Record<string, string | number> {
  const origin = req ? localhostCorsOrigin(req) : undefined;
  return {
    ...headers,
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Accept",
      "Access-Control-Max-Age": "600"
    } : {})
  };
}

function applyHostCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = localhostCorsOrigin(req);
  if (!origin) return;
  const headers = hostResponseHeaders(req);
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
}

function sendOptions(req: IncomingMessage, res: ServerResponse): void {
  const origin = localhostCorsOrigin(req);
  if (!origin && req.headers.origin) {
    sendJson(res, 403, { ok: false, error: "origin not allowed" });
    return;
  }
  res.writeHead(204, hostResponseHeaders(req));
  res.end();
}

function sendJson(res: ServerResponse, status: number, value: unknown, headOnly = false): void {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  if (!headOnly) res.end(body);
  else res.end();
}

function sendText(res: ServerResponse, status: number, value: string, headOnly = false): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(value)
  });
  if (!headOnly) res.end(value);
  else res.end();
}

function sendSseEvent(res: ServerResponse, event: string, value: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  return JSON.parse(body);
}

function isHostCommandRequest(value: unknown): value is HostCommandRequest {
  return Boolean(value && typeof value === "object" && typeof (value as { command?: unknown }).command === "string");
}

function hostCommandHttpStatus(result: HostCommandResult): number {
  if (result.exitCode === 66) return 404;
  return result.ok || result.exitCode === 1 ? 200 : 400;
}

async function runHostCommandRoute(
  res: ServerResponse,
  runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>,
  request: HostCommandRequest,
  headOnly = false
): Promise<void> {
  try {
    const result = await runCommand(request);
    sendJson(res, hostCommandHttpStatus(result), result, headOnly);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }, headOnly);
  }
}

function decodePathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeStatusStreamInterval(value: unknown): number {
  const n = Number(value ?? process.env.KING_HOST_STATUS_STREAM_INTERVAL_MS ?? 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

function normalizeTimelineLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return 20;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function buildHostCapabilities() {
  const commands = listHostCommands();
  return {
    ok: true,
    service: "king host",
    readOnly: true,
    localhostOnly: true,
    remoteApi: false,
    cors: {
      enabled: true,
      allowedOrigins: ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*", "https://localhost:*", "https://127.0.0.1:*", "https://[::1]:*"]
    },
    resources: [...HOST_RESOURCE_ENDPOINTS],
    streams: [...HOST_STREAM_ENDPOINTS],
    commands,
    safeExecutorCommands: listSafeHostExecutorCommands(),
    destructiveCommands: commands.filter((entry) => entry.destructive).map((entry) => entry.name),
    commandEnvelope: {
      path: "/commands/run",
      method: "POST"
    }
  };
}

export function createHostStatusServer(options: HostStatusServerOptions = {}): Server {
  const readState = options.readState ?? readRunningState;
  const tokenBudget = options.tokenBudget ?? tokenBudgetFromEnv;
  const usagePricing = options.usagePricing ?? usagePricingFromEnv;
  const readTimeline = options.readTimeline ?? ((limit?: number) => readHostTimeline({ limit }));
  const readRuns = options.readRuns ?? ((input?: HostRunListInput) => listHostRunRequests(input));
  const runCommand = options.runCommand ?? ((request: HostCommandRequest) => runHostCommand(request, { readState, tokenBudget, usagePricing, recordTimeline: true }));
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const method = req.method ?? "GET";
      if (method === "OPTIONS") {
        sendOptions(req, res);
        return;
      }
      applyHostCorsHeaders(req, res);
      const headOnly = method === "HEAD";
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/commands/run") {
        if (method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        const body = await readJsonBody(req);
        if (!isHostCommandRequest(body)) {
          sendJson(res, 400, { ok: false, error: "command is required" });
          return;
        }
        await runHostCommandRoute(res, runCommand, body, headOnly);
        return;
      }

      if (url.pathname === "/runs") {
        if (method === "GET" || method === "HEAD") {
          await runHostCommandRoute(res, runCommand, {
            command: "run-requests",
            format: "json",
            input: {
              limit: url.searchParams.get("limit") ?? undefined,
              status: url.searchParams.get("status") ?? undefined
            }
          }, headOnly);
          return;
        }
        if (method === "POST") {
          await runHostCommandRoute(res, runCommand, {
            command: "submit-run",
            format: "json",
            input: await readJsonBody(req)
          });
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
        return;
      }

      if (url.pathname === "/runs/execute") {
        if (method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        const body = await readJsonBody(req);
        await runHostCommandRoute(res, runCommand, {
          command: "execute-run",
          format: "json",
          input: body && typeof body === "object" ? body : {}
        });
        return;
      }

      if (url.pathname === "/runs/stream") {
        if (method !== "GET" && method !== "HEAD") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        if (headOnly) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "Connection": "keep-alive"
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive"
        });
        const interval = normalizeStatusStreamInterval(url.searchParams.get("interval"));
        const limit = normalizeTimelineLimit(url.searchParams.get("limit"));
        const status = url.searchParams.get("status") ?? undefined;
        let closed = false;
        let busy = false;
        const sendRuns = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            sendSseEvent(res, "runs", { requests: await readRuns({ limit, status: status as HostRunListInput["status"] }) });
          } catch (err) {
            sendSseEvent(res, "error", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void sendRuns(), interval);
        timer.unref?.();
        req.once("close", () => {
          closed = true;
          clearInterval(timer);
        });
        await sendRuns();
        return;
      }

      if (url.pathname === "/runs/plan" || url.pathname === "/runs/preflight" || url.pathname === "/runs/prepare-layout") {
        if (method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        await runHostCommandRoute(res, runCommand, {
          command: url.pathname === "/runs/plan"
            ? "plan-run"
            : url.pathname === "/runs/preflight"
              ? "preflight"
              : "prepare-run-layout",
          format: "json",
          input: await readJsonBody(req)
        });
        return;
      }

      const runPath = url.pathname.match(/^\/runs\/([^/]+)(?:\/([^/]+))?$/);
      if (runPath) {
        const id = decodePathPart(runPath[1] ?? "");
        const action = runPath[2] ? decodePathPart(runPath[2]) : undefined;
        if (!id) {
          sendJson(res, 400, { ok: false, error: "run id is required" }, headOnly);
          return;
        }
        if (action === "stream") {
          if (method !== "GET" && method !== "HEAD") {
            sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
            return;
          }
          if (headOnly) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "Connection": "keep-alive"
            });
            res.end();
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "Connection": "keep-alive"
          });
          const interval = normalizeStatusStreamInterval(url.searchParams.get("interval"));
          let closed = false;
          let busy = false;
          const sendRun = async () => {
            if (closed || busy) return;
            busy = true;
            try {
              const request = (await readRuns({ limit: 100 })).find((entry) => entry.id === id) ?? null;
              const outputDir = request?.spec.options?.outputDir;
              const [heartbeat, meta] = outputDir
                ? await Promise.all([
                    readHostRunHeartbeat({ outputDir }),
                    readHostRunMeta({ outputDir })
                  ])
                : [null, null];
              sendSseEvent(res, "run", {
                request,
                heartbeat: heartbeat?.heartbeat ?? null,
                meta: meta?.meta ?? null
              });
            } catch (err) {
              sendSseEvent(res, "error", { error: err instanceof Error ? err.message : String(err) });
            } finally {
              busy = false;
            }
          };
          const timer = setInterval(() => void sendRun(), interval);
          timer.unref?.();
          req.once("close", () => {
            closed = true;
            clearInterval(timer);
          });
          await sendRun();
          return;
        }
        if (!action && (method === "GET" || method === "HEAD")) {
          await runHostCommandRoute(res, runCommand, {
            command: "run-request",
            format: "json",
            input: { id }
          }, headOnly);
          return;
        }
        if (!action && method === "PATCH") {
          await runHostCommandRoute(res, runCommand, {
            command: "update-run",
            format: "json",
            input: { ...(await readJsonBody(req) as object), id }
          });
          return;
        }
        if (!action && method === "DELETE") {
          const body = await readJsonBody(req);
          await runHostCommandRoute(res, runCommand, {
            command: "cancel-run",
            format: "json",
            input: { ...(body && typeof body === "object" ? body as object : {}), id }
          });
          return;
        }
        if (action === "execute" && method === "POST") {
          const body = await readJsonBody(req);
          await runHostCommandRoute(res, runCommand, {
            command: "execute-run",
            format: "json",
            input: { ...(body && typeof body === "object" ? body as object : {}), id }
          });
          return;
        }
        if (action === "events" && method === "POST") {
          const body = await readJsonBody(req);
          await runHostCommandRoute(res, runCommand, {
            command: "emit-run-event",
            format: "json",
            input: { ...(body && typeof body === "object" ? body as object : {}), id }
          });
          return;
        }
        if (action === "events" && (method === "GET" || method === "HEAD")) {
          await runHostCommandRoute(res, runCommand, {
            command: "watch-run",
            format: "json",
            input: {
              id,
              tail: url.searchParams.get("tail") ?? undefined,
              type: url.searchParams.get("type") ?? undefined,
              agent: url.searchParams.get("agent") ?? undefined,
              classification: url.searchParams.get("classification") ?? undefined,
              file: url.searchParams.get("file") ?? undefined,
              outputDir: url.searchParams.get("outputDir") ?? undefined,
              writeResults: parseOptionalBoolean(url.searchParams.get("writeResults"))
            }
          }, headOnly);
          return;
        }
        if (action === "results" && (method === "GET" || method === "HEAD")) {
          await runHostCommandRoute(res, runCommand, {
            command: "run-results",
            format: "json",
            input: {
              id,
              file: url.searchParams.get("file") ?? undefined,
              outputDir: url.searchParams.get("outputDir") ?? undefined,
              resultsFile: url.searchParams.get("resultsFile") ?? undefined
            }
          }, headOnly);
          return;
        }
        if (action === "heartbeat" && (method === "GET" || method === "HEAD")) {
          await runHostCommandRoute(res, runCommand, {
            command: "run-heartbeat",
            format: "json",
            input: {
              id,
              file: url.searchParams.get("file") ?? undefined,
              outputDir: url.searchParams.get("outputDir") ?? undefined
            }
          }, headOnly);
          return;
        }
        if (action === "meta" && (method === "GET" || method === "HEAD")) {
          await runHostCommandRoute(res, runCommand, {
            command: "run-meta",
            format: "json",
            input: {
              id,
              file: url.searchParams.get("file") ?? undefined,
              outputDir: url.searchParams.get("outputDir") ?? undefined
            }
          }, headOnly);
          return;
        }
        sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
        return;
      }

      if (url.pathname === "/exports/plan" || url.pathname === "/exports") {
        if (method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        await runHostCommandRoute(res, runCommand, {
          command: url.pathname === "/exports/plan" ? "plan-export" : "export",
          format: "json",
          input: await readJsonBody(req)
        });
        return;
      }

      const policyPath = url.pathname.match(/^\/policy\/([^/]+)$/);
      if (policyPath) {
        const command = decodePathPart(policyPath[1] ?? "");
        if (!command) {
          sendJson(res, 400, { ok: false, error: "policy command is required" }, headOnly);
          return;
        }
        if (method !== "GET" && method !== "HEAD" && method !== "POST") {
          sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
          return;
        }
        const input = method === "POST" ? await readJsonBody(req) : {};
        await runHostCommandRoute(res, runCommand, {
          command: "policy",
          format: "json",
          input: { ...(input && typeof input === "object" ? input as object : {}), command }
        }, headOnly);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "method not allowed" }, headOnly);
        return;
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          service: "king host",
          readOnly: true,
          commands: listHostCommands().map((entry) => entry.name)
        }, headOnly);
        return;
      }
      if (url.pathname === "/capabilities") {
        sendJson(res, 200, buildHostCapabilities(), headOnly);
        return;
      }
      if (url.pathname === "/host/snapshot") {
        const limit = normalizeTimelineLimit(url.searchParams.get("limit"));
        const timelineLimit = normalizeTimelineLimit(url.searchParams.get("timelineLimit") ?? url.searchParams.get("limit"));
        const runLimit = normalizeTimelineLimit(url.searchParams.get("runLimit") ?? url.searchParams.get("limit"));
        const runStatus = url.searchParams.get("status") ?? undefined;
        sendJson(res, 200, {
          ok: true,
          status: buildHostStatusSnapshot(await readState(), tokenBudget(), usagePricing()),
          capabilities: buildHostCapabilities(),
          timeline: await readTimeline(timelineLimit ?? limit),
          runs: await readRuns({ limit: runLimit ?? limit, status: runStatus as HostRunListInput["status"] })
        }, headOnly);
        return;
      }
      if (url.pathname === "/host/stream") {
        if (headOnly) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "Connection": "keep-alive"
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive"
        });
        const interval = normalizeStatusStreamInterval(url.searchParams.get("interval") ?? options.statusStreamIntervalMs);
        const timelineLimit = normalizeTimelineLimit(url.searchParams.get("timelineLimit") ?? url.searchParams.get("limit"));
        const runLimit = normalizeTimelineLimit(url.searchParams.get("runLimit") ?? url.searchParams.get("limit"));
        const runStatus = url.searchParams.get("status") ?? undefined;
        let closed = false;
        let busy = false;
        const sendHostFrame = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            sendSseEvent(res, "status", buildHostStatusSnapshot(await readState(), tokenBudget(), usagePricing()));
            sendSseEvent(res, "timeline", await readTimeline(timelineLimit));
            sendSseEvent(res, "runs", { requests: await readRuns({ limit: runLimit, status: runStatus as HostRunListInput["status"] }) });
          } catch (err) {
            sendSseEvent(res, "error", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void sendHostFrame(), interval);
        timer.unref?.();
        req.once("close", () => {
          closed = true;
          clearInterval(timer);
        });
        await sendHostFrame();
        return;
      }
      if (url.pathname === "/commands") {
        sendJson(res, 200, {
          ok: true,
          commands: listHostCommands()
        }, headOnly);
        return;
      }
      if (url.pathname === "/timeline") {
        await runHostCommandRoute(res, runCommand, {
          command: "timeline",
          format: "json",
          input: {
            limit: url.searchParams.get("limit") ?? undefined
          }
        }, headOnly);
        return;
      }
      if (url.pathname === "/timeline/stream") {
        if (headOnly) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "Connection": "keep-alive"
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive"
        });
        const interval = normalizeStatusStreamInterval(url.searchParams.get("interval"));
        const limit = normalizeTimelineLimit(url.searchParams.get("limit"));
        let closed = false;
        let busy = false;
        const sendTimeline = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            sendSseEvent(res, "timeline", await readTimeline(limit));
          } catch (err) {
            sendSseEvent(res, "error", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void sendTimeline(), interval);
        timer.unref?.();
        req.once("close", () => {
          closed = true;
          clearInterval(timer);
        });
        await sendTimeline();
        return;
      }
      if (url.pathname === "/usage" || url.pathname === "/expenses" || url.pathname === "/doctor") {
        await runHostCommandRoute(res, runCommand, {
          command: url.pathname === "/usage" ? "usage" : url.pathname === "/expenses" ? "expenses" : "doctor",
          format: "json"
        }, headOnly);
        return;
      }
      if (url.pathname === "/status/stream") {
        if (headOnly) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            "Connection": "keep-alive"
          });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          "Connection": "keep-alive"
        });
        const interval = normalizeStatusStreamInterval(url.searchParams.get("interval") ?? options.statusStreamIntervalMs);
        let closed = false;
        let busy = false;
        const sendSnapshot = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            sendSseEvent(res, "status", buildHostStatusSnapshot(await readState(), tokenBudget(), usagePricing()));
          } catch (err) {
            sendSseEvent(res, "error", { error: err instanceof Error ? err.message : String(err) });
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void sendSnapshot(), interval);
        timer.unref?.();
        req.once("close", () => {
          closed = true;
          clearInterval(timer);
        });
        await sendSnapshot();
        return;
      }

      const snapshot = buildHostStatusSnapshot(await readState(), tokenBudget(), usagePricing());
      if (url.pathname === "/status") {
        sendJson(res, 200, snapshot, headOnly);
        return;
      }
      if (url.pathname === "/status.txt") {
        sendText(res, 200, `${formatHostStatusSnapshot(snapshot)}\n`, headOnly);
        return;
      }
      if (url.pathname === "/events") {
        sendJson(res, 200, {
          ok: snapshot.ok,
          events: snapshot.events
        }, headOnly);
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" }, headOnly);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export async function startHostStatusServer(options: HostStatusServerOptions = {}): Promise<Server> {
  const host = normalizeHostServerHost(options.host);
  const port = options.port ?? hostServerPortFromEnv();
  const server = createHostStatusServer(options);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  attachHostRunAutoExecutor(server, options);
  return server;
}

export async function serveHostStatus(options: HostStatusServerOptions = {}): Promise<void> {
  const server = await startHostStatusServer(options);
  const address = server.address();
  const host = normalizeHostServerHost(options.host);
  const port = typeof address === "object" && address ? address.port : options.port ?? hostServerPortFromEnv();
  console.log(`host status server listening on http://${host}:${port}`);
  console.log("read-only endpoints: /health, /capabilities, /status, /host/snapshot, /host/stream, /status/stream, /status.txt, /events, /timeline, /timeline/stream, /usage, /expenses, /doctor, /commands");
  console.log("controlled command endpoint: POST /commands/run");
  console.log("host run endpoints: POST /runs/plan, POST /runs/preflight, POST /runs/prepare-layout, GET/POST /runs, GET /runs/stream, GET/PATCH /runs/:id, GET /runs/:id/stream, GET /runs/:id/events, GET /runs/:id/results, GET /runs/:id/heartbeat, GET /runs/:id/meta, POST /runs/:id/execute");
  console.log("host export endpoints: POST /exports/plan, POST /exports");
  console.log("host policy endpoints: GET/POST /policy/:command");
  if (options.executeRuns) console.log(`host run auto-executor enabled every ${normalizeExecuteRunsInterval(options.executeRunsIntervalMs)}ms`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function attachHostRunAutoExecutor(server: Server, options: HostStatusServerOptions): void {
  if (!options.executeRuns) return;
  const runCommand = options.runCommand ?? ((request: HostCommandRequest) => runHostCommand(request, {
    readState: options.readState ?? readRunningState,
    tokenBudget: options.tokenBudget ?? tokenBudgetFromEnv,
    usagePricing: options.usagePricing ?? usagePricingFromEnv,
    recordTimeline: true
  }));
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void runCommand({ command: "execute-run", format: "json" }).catch((err: unknown) => {
      console.warn(`host run auto-executor failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(() => {
      busy = false;
    });
  };
  const timer = setInterval(tick, normalizeExecuteRunsInterval(options.executeRunsIntervalMs));
  timer.unref?.();
  server.once("close", () => clearInterval(timer));
  tick();
}

function normalizeExecuteRunsInterval(value: unknown): number {
  const n = Number(value ?? process.env.KING_HOST_EXECUTE_RUNS_INTERVAL_MS ?? 1000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

function parseOptionalBoolean(value: string | null): boolean | undefined {
  if (value === null || value === "") return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  return undefined;
}
