import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HOST_EVENTS_PATH } from "./paths.js";

export type HostTimelineEventType = "host.command";

export interface HostTimelineEvent {
  at: string;
  type: HostTimelineEventType;
  command: string;
  ok: boolean;
  exitCode: number;
  destructive: boolean;
  durationMs: number;
  actorRole?: string;
  textPreview?: string;
  jsonSummary?: unknown;
  error?: string;
}

export interface HostTimelineReadOptions {
  path?: string;
  limit?: number;
}

export function hostTimelinePath(path = HOST_EVENTS_PATH): string {
  return path;
}

export async function appendHostTimelineEvent(event: HostTimelineEvent, path = HOST_EVENTS_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readHostTimeline(options: HostTimelineReadOptions = {}): Promise<HostTimelineEvent[]> {
  const path = options.path ?? HOST_EVENTS_PATH;
  const limit = normalizeLimit(options.limit);
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }
  const events = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as HostTimelineEvent;
        return isHostTimelineEvent(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
  return limit ? events.slice(-limit) : events;
}

export function formatHostTimeline(events: HostTimelineEvent[]): string {
  if (events.length === 0) return "no host command events";
  return events.map((event) => {
    const status = event.ok ? "ok" : "failed";
    const role = event.actorRole ? ` role=${event.actorRole}` : "";
    const destructive = event.destructive ? " destructive" : "";
    const error = event.error ? ` error=${event.error}` : "";
    return `${event.at} ${event.command} ${status} exit=${event.exitCode}${role}${destructive} ${event.durationMs}ms${error}`;
  }).join("\n");
}

export function summarizeHostCommandJson(command: string, json: unknown): unknown {
  if (!json || typeof json !== "object") return undefined;
  const value = json as Record<string, unknown>;
  if (command === "status") {
    return {
      ok: value.ok,
      computerId: value.computerId,
      agents: Array.isArray(value.agents) ? value.agents.length : undefined,
      events: Array.isArray(value.events) ? value.events.length : undefined
    };
  }
  if (command === "usage") {
    return {
      agents: value.agents,
      totalTokens: value.totalTokens,
      budget: value.budget
    };
  }
  if (command === "events") {
    return { events: Array.isArray(value.events) ? value.events.length : undefined };
  }
  if (command === "timeline") {
    return { events: Array.isArray(value.events) ? value.events.length : undefined };
  }
  if (command === "doctor") {
    return {
      exitCode: value.exitCode,
      results: Array.isArray(value.results) ? value.results.length : undefined
    };
  }
  if (command === "plan-run" || command === "preflight") {
    return {
      ready: value.ready,
      mode: (value.options as { mode?: unknown } | undefined)?.mode,
      engine: (value.options as { engine?: unknown } | undefined)?.engine,
      errors: Array.isArray(value.errors) ? value.errors.length : undefined,
      warnings: Array.isArray(value.warnings) ? value.warnings.length : undefined
    };
  }
  if (command === "submit-run") {
    const request = value.request as { id?: unknown; status?: unknown; ready?: unknown; effectiveEngine?: unknown } | undefined;
    return {
      requestId: request?.id,
      status: request?.status,
      ready: request?.ready,
      effectiveEngine: request?.effectiveEngine
    };
  }
  if (command === "run-requests") {
    return { requests: Array.isArray(value.requests) ? value.requests.length : undefined };
  }
  if (command === "run-request" || command === "update-run") {
    const request = value.request as { id?: unknown; status?: unknown; ready?: unknown; effectiveEngine?: unknown } | undefined;
    return {
      requestId: request?.id,
      status: request?.status,
      ready: request?.ready,
      effectiveEngine: request?.effectiveEngine
    };
  }
  if (command === "execute-run") {
    const request = value.request as { id?: unknown; status?: unknown; result?: { command?: unknown; ok?: unknown; exitCode?: unknown } } | undefined;
    return {
      requestId: request?.id,
      status: request?.status,
      resultCommand: request?.result?.command,
      resultOk: request?.result?.ok,
      resultExitCode: request?.result?.exitCode
    };
  }
  if (command === "plan-export") {
    return {
      runId: value.runId,
      exportDir: value.exportDir,
      workspaceFileCount: value.workspaceFileCount,
      repoPatchFiles: Array.isArray(value.repoPatchFiles) ? value.repoPatchFiles.length : undefined
    };
  }
  if (command === "export") {
    return {
      runId: value.runId,
      exportDir: value.exportDir,
      writtenFiles: Array.isArray(value.writtenFiles) ? value.writtenFiles.length : undefined
    };
  }
  return undefined;
}

export function previewText(value: string, maxLength = 240): string | undefined {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function isHostTimelineEvent(value: unknown): value is HostTimelineEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as HostTimelineEvent;
  return event.type === "host.command" &&
    typeof event.at === "string" &&
    typeof event.command === "string" &&
    typeof event.ok === "boolean" &&
    typeof event.exitCode === "number" &&
    typeof event.destructive === "boolean" &&
    typeof event.durationMs === "number";
}
