import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { RunningEvent, RunningState } from "./service.js";
import type { UsagePricingRule, UsageSummary } from "./usage.js";
import { summarizeAgentUsage } from "./usage.js";

export type RuntimeClassification = "productive" | "idle" | "blocked" | "backlog_stuck" | "error";

export interface ProviderCapability {
  provider: string;
  engines: string[];
  usage: "local_tokens" | "api_usage" | "unavailable";
  pricing: "env_pricing" | "provider_api" | "unavailable";
  notes: string[];
}

export interface RuntimeResultsRow {
  agent: string;
  engine: string;
  runId: string;
  source: string;
  status: string;
  durationMs: number;
  tokens: number;
  classification: RuntimeClassification;
  reason: string;
}

export interface UsageRuntimeDataFile {
  schemaVersion: 1;
  dataSource: {
    mode: "daemon-state";
    generatedAt: string;
    secretValuesIncluded: false;
    warnings: string[];
  };
  usage: UsageSummary;
  providerCapabilities: ProviderCapability[];
  runtimeResults: RuntimeResultsRow[];
  state: {
    version?: string;
    pid?: number;
    startedAt?: string;
    serverUrl?: string;
    computerId?: string;
    workspaces: string[];
    agents: Array<{
      id: string;
      name: string;
      engine: string;
      lifecycle?: string;
      status?: string;
      model?: string;
      workspaceRoot?: string;
      updatedAt: string;
    }>;
    events: RunningEvent[];
  };
}

export const PROVIDER_CAPABILITIES: ProviderCapability[] = [
  {
    provider: "OpenAI",
    engines: ["codex"],
    usage: "local_tokens",
    pricing: "env_pricing",
    notes: ["King AI records CLI-reported token usage when available.", "Set KING_AI_USAGE_PRICING for estimated local cost."]
  },
  {
    provider: "Anthropic",
    engines: ["claude"],
    usage: "local_tokens",
    pricing: "env_pricing",
    notes: ["King AI records Claude CLI usage fields when the engine returns them.", "Set KING_AI_USAGE_PRICING for estimated local cost."]
  },
  {
    provider: "OpenRouter",
    engines: ["openrouter"],
    usage: "unavailable",
    pricing: "env_pricing",
    notes: ["No first-class King AI engine adapter is wired yet.", "Pricing can still be represented with KING_AI_USAGE_PRICING once an adapter records usage."]
  }
];

export const RUNTIME_RESULTS_HEADER = [
  "agent",
  "engine",
  "run_id",
  "source",
  "status",
  "duration_ms",
  "tokens",
  "classification",
  "reason"
].join("\t") + "\n";

export function formatProviderCapabilities(capabilities: ProviderCapability[] = PROVIDER_CAPABILITIES): string {
  return [
    "provider capabilities:",
    ...capabilities.map((capability) =>
      `  - ${capability.provider}: engines=${capability.engines.join(",") || "none"} usage=${capability.usage} pricing=${capability.pricing}`
    )
  ].join("\n");
}

export function classifyRuntimeEvent(event: RunningEvent): { classification: RuntimeClassification; reason: string } {
  const kind = event.kind.toLowerCase();
  const detail = event.detail ?? "";
  if (/error|failed|failure/.test(kind) || /error|failed|usage limit|quota/i.test(detail)) {
    return { classification: "error", reason: detail || event.kind };
  }
  if (/blocked|budget\.exceeded/.test(kind) || /blocked|waiting for dependency/i.test(detail)) {
    return { classification: "blocked", reason: detail || event.kind };
  }
  if (/wake\.received|queue\.backlog|agenda/.test(kind) && /pending|unread|backlog/i.test(detail)) {
    return { classification: "backlog_stuck", reason: detail || event.kind };
  }
  if (/turn\.completed|task\.transition|artifact\.created|engine\.session\.started/.test(kind)) {
    return { classification: "productive", reason: detail || event.kind };
  }
  return { classification: "idle", reason: detail || event.kind };
}

export function buildRuntimeResultsRows(state: RunningState | null): RuntimeResultsRow[] {
  const events = state?.events ?? [];
  const rows: RuntimeResultsRow[] = [];
  for (const agent of state?.agents ?? []) {
    if (!agent.runStats || agent.runStats.turns === 0) continue;
    const latestEvent = [...events].reverse().find((event) => event.detail?.includes(agent.id)) ?? events.at(-1);
    const classified = latestEvent ? classifyRuntimeEvent(latestEvent) : { classification: agent.runStats.failed > 0 ? "error" as const : "idle" as const, reason: "run stats only" };
    rows.push({
      agent: agent.id,
      engine: agent.engine,
      runId: agent.runStats.lastRunAt ?? "",
      source: "daemon-state",
      status: agent.runStats.lastStatus ?? agent.status ?? "unknown",
      durationMs: agent.runStats.lastDurationMs ?? 0,
      tokens: agent.runStats.totalTokens,
      classification: classified.classification,
      reason: classified.reason
    });
  }
  return rows.sort((left, right) => left.agent.localeCompare(right.agent));
}

export function formatRuntimeResultsTable(rows: RuntimeResultsRow[]): string {
  return RUNTIME_RESULTS_HEADER + rows.map((row) => [
    row.agent,
    row.engine,
    row.runId,
    row.source,
    row.status,
    String(row.durationMs),
    String(row.tokens),
    row.classification,
    row.reason
  ].map(tsvCell).join("\t")).join("\n") + (rows.length ? "\n" : "");
}

export function buildUsageRuntimeData(
  state: RunningState | null,
  options: { budget?: number | null; pricingRules?: UsagePricingRule[]; generatedAt?: string } = {}
): UsageRuntimeDataFile {
  const usage = summarizeAgentUsage(state?.agents ?? [], options.budget, options.pricingRules ?? []);
  const warnings: string[] = [];
  if (!state) warnings.push("No running daemon state was found.");
  if (!usage.turns) warnings.push("No completed agent run usage has been recorded yet.");
  const workspaces = state?.capabilities?.workspaces ?? [];
  return sanitizeRuntimeData({
    schemaVersion: 1,
    dataSource: {
      mode: "daemon-state",
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      secretValuesIncluded: false,
      warnings
    },
    usage,
    providerCapabilities: PROVIDER_CAPABILITIES,
    runtimeResults: buildRuntimeResultsRows(state),
    state: {
      version: state?.version,
      pid: state?.pid,
      startedAt: state?.startedAt,
      serverUrl: state?.serverUrl,
      computerId: state?.computerId,
      workspaces,
      agents: (state?.agents ?? []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        engine: agent.engine,
        lifecycle: agent.lifecycle,
        status: agent.status,
        model: agent.model,
        workspaceRoot: agent.workspaceRoot,
        updatedAt: agent.updatedAt
      })),
      events: state?.events ?? []
    }
  });
}

export async function writeUsageRuntimeData(file: string, data: UsageRuntimeDataFile): Promise<string> {
  const out = resolve(file);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data, null, 2), "utf8");
  return out;
}

export function sanitizeRuntimeData<T>(value: T, home = homedir()): T {
  return sanitizeValue(value, normalizePath(home)) as T;
}

function sanitizeValue(value: unknown, home: string): unknown {
  if (typeof value === "string") return sanitizeString(value, home);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, home));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, home)]));
}

function sanitizeString(value: string, home: string): string {
  const normalized = normalizePath(value);
  if (home && normalized === home) return "<home>";
  if (home && normalized.startsWith(`${home}/`)) return `<home>/${normalized.slice(home.length + 1)}`;
  const homeRedacted = home ? value.replace(new RegExp(escapeRegExp(home), "g"), "<home>") : value;
  return homeRedacted.replace(/\/Users\/[^/\s"]+/g, "private://user");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tsvCell(value: string): string {
  return value.replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}
