import { join, resolve } from "node:path";
import { appendJsonl, readJsonl } from "./jsonl.js";

export interface HostFeedbackPathInput {
  outputDir?: string;
  feedbackFile?: string;
}

export interface HostFeedbackRecordInput extends HostFeedbackPathInput {
  runId?: string;
  agent?: string;
  taskId?: string;
  capsuleId?: string;
  status?: "completed" | "failed" | "partial" | "cancelled";
  rating?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  skill?: string;
  taskCompleted?: boolean;
  errored?: boolean;
  humanIntervention?: boolean;
  note?: string;
}

export interface HostFeedbackListInput extends HostFeedbackPathInput {
  runId?: string;
  agent?: string;
  skill?: string;
  limit?: number;
}

export interface HostFeedbackRecord {
  schema: "king-ai.host-feedback.v1";
  createdAt: string;
  runId?: string;
  agent?: string;
  taskId?: string;
  capsuleId?: string;
  status: "completed" | "failed" | "partial" | "cancelled";
  rating?: number;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  skill?: string;
  taskCompleted: boolean;
  errored: boolean;
  humanIntervention: boolean;
  note?: string;
}

export interface HostFeedbackSummary {
  records: number;
  completed: number;
  failed: number;
  partial: number;
  cancelled: number;
  taskCompleted: number;
  errored: number;
  humanIntervention: number;
  totalDurationMs: number;
  totalTokens: number;
  byAgent: Array<{ agent: string; records: number; completed: number; failed: number; totalTokens: number }>;
  bySkill: Array<{ skill: string; records: number; completed: number; failed: number; totalTokens: number }>;
}

export function hostFeedbackPathForOutputDir(outputDir = "deliverables"): string {
  return join(resolve(outputDir), "run-feedback.jsonl");
}

export async function recordHostFeedback(
  input: HostFeedbackRecordInput,
  now: () => Date = () => new Date(),
): Promise<HostFeedbackRecord> {
  const inputTokens = nonNegativeInteger(input.inputTokens, "inputTokens") ?? 0;
  const outputTokens = nonNegativeInteger(input.outputTokens, "outputTokens") ?? 0;
  const totalTokens = nonNegativeInteger(input.totalTokens, "totalTokens") ?? inputTokens + outputTokens;
  const status = normalizeStatus(input.status ?? (input.errored ? "failed" : "completed"));
  const record: HostFeedbackRecord = {
    schema: "king-ai.host-feedback.v1",
    createdAt: now().toISOString(),
    runId: cleanString(input.runId),
    agent: cleanString(input.agent),
    taskId: cleanString(input.taskId),
    capsuleId: cleanString(input.capsuleId),
    status,
    rating: normalizeRating(input.rating),
    durationMs: nonNegativeInteger(input.durationMs, "durationMs"),
    inputTokens,
    outputTokens,
    totalTokens,
    skill: cleanString(input.skill),
    taskCompleted: input.taskCompleted ?? status === "completed",
    errored: input.errored ?? status === "failed",
    humanIntervention: input.humanIntervention ?? false,
    note: cleanString(input.note),
  };
  const cleaned = dropUndefined(record);
  await appendJsonl(feedbackPath(input), cleaned);
  return cleaned;
}

export async function listHostFeedback(input: HostFeedbackListInput = {}): Promise<HostFeedbackRecord[]> {
  const runId = cleanString(input.runId);
  const agent = cleanString(input.agent);
  const skill = cleanString(input.skill);
  const records = (await readJsonl(feedbackPath(input))).filter(isFeedbackRecord).filter((record) => {
    if (runId && record.runId !== runId) return false;
    if (agent && record.agent !== agent) return false;
    if (skill && record.skill !== skill) return false;
    return true;
  });
  const limit = normalizeLimit(input.limit);
  return limit ? records.slice(-limit).reverse() : records;
}

export async function summarizeHostFeedback(input: HostFeedbackListInput = {}): Promise<HostFeedbackSummary> {
  return summarizeFeedback(await listHostFeedback(input));
}

export function formatHostFeedback(records: HostFeedbackRecord[]): string {
  if (records.length === 0) return "no host feedback";
  return records
    .map((record) => {
      const subject = [record.runId, record.taskId, record.capsuleId].filter(Boolean).join(" ") || "(no subject)";
      return `${record.createdAt} ${record.status}${record.agent ? ` @${record.agent}` : ""} ${subject} tokens=${record.totalTokens}${record.note ? ` ${record.note}` : ""}`;
    })
    .join("\n");
}

export function formatHostFeedbackSummary(summary: HostFeedbackSummary): string {
  const lines = [
    `feedback: records=${summary.records} completed=${summary.completed} failed=${summary.failed} partial=${summary.partial} cancelled=${summary.cancelled}`,
    `tasks: completed=${summary.taskCompleted} errored=${summary.errored} humanIntervention=${summary.humanIntervention}`,
    `usage: durationMs=${summary.totalDurationMs} tokens=${summary.totalTokens}`,
  ];
  if (summary.byAgent.length) {
    lines.push("by agent:");
    for (const entry of summary.byAgent)
      lines.push(
        `  - ${entry.agent}: records=${entry.records} completed=${entry.completed} failed=${entry.failed} tokens=${entry.totalTokens}`,
      );
  }
  if (summary.bySkill.length) {
    lines.push("by skill:");
    for (const entry of summary.bySkill)
      lines.push(
        `  - ${entry.skill}: records=${entry.records} completed=${entry.completed} failed=${entry.failed} tokens=${entry.totalTokens}`,
      );
  }
  return lines.join("\n");
}

function summarizeFeedback(records: HostFeedbackRecord[]): HostFeedbackSummary {
  const byAgent = new Map<
    string,
    { agent: string; records: number; completed: number; failed: number; totalTokens: number }
  >();
  const bySkill = new Map<
    string,
    { skill: string; records: number; completed: number; failed: number; totalTokens: number }
  >();
  const summary: HostFeedbackSummary = {
    records: records.length,
    completed: 0,
    failed: 0,
    partial: 0,
    cancelled: 0,
    taskCompleted: 0,
    errored: 0,
    humanIntervention: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    byAgent: [],
    bySkill: [],
  };
  for (const record of records) {
    summary[record.status] += 1;
    if (record.taskCompleted) summary.taskCompleted += 1;
    if (record.errored) summary.errored += 1;
    if (record.humanIntervention) summary.humanIntervention += 1;
    summary.totalDurationMs += record.durationMs ?? 0;
    summary.totalTokens += record.totalTokens;
    if (record.agent) addGroup(byAgent, record.agent, record);
    if (record.skill) addSkillGroup(bySkill, record.skill, record);
  }
  summary.byAgent = [...byAgent.values()];
  summary.bySkill = [...bySkill.values()];
  return summary;
}

function addGroup(
  groups: Map<string, { agent: string; records: number; completed: number; failed: number; totalTokens: number }>,
  agent: string,
  record: HostFeedbackRecord,
): void {
  const entry = groups.get(agent) ?? { agent, records: 0, completed: 0, failed: 0, totalTokens: 0 };
  entry.records += 1;
  if (record.status === "completed") entry.completed += 1;
  if (record.status === "failed") entry.failed += 1;
  entry.totalTokens += record.totalTokens;
  groups.set(agent, entry);
}

function addSkillGroup(
  groups: Map<string, { skill: string; records: number; completed: number; failed: number; totalTokens: number }>,
  skill: string,
  record: HostFeedbackRecord,
): void {
  const entry = groups.get(skill) ?? { skill, records: 0, completed: 0, failed: 0, totalTokens: 0 };
  entry.records += 1;
  if (record.status === "completed") entry.completed += 1;
  if (record.status === "failed") entry.failed += 1;
  entry.totalTokens += record.totalTokens;
  groups.set(skill, entry);
}

function feedbackPath(input: HostFeedbackPathInput): string {
  return input.feedbackFile ? resolve(input.feedbackFile) : hostFeedbackPathForOutputDir(input.outputDir);
}

function isFeedbackRecord(value: unknown): value is HostFeedbackRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as HostFeedbackRecord;
  return (
    record.schema === "king-ai.host-feedback.v1" &&
    typeof record.createdAt === "string" &&
    typeof record.totalTokens === "number"
  );
}

function normalizeStatus(value: unknown): HostFeedbackRecord["status"] {
  if (value === "completed" || value === "failed" || value === "partial" || value === "cancelled") return value;
  throw new Error(`invalid feedback status: ${String(value)}`);
}

function normalizeRating(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) throw new Error("rating must be between 1 and 5");
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return Math.floor(parsed);
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("limit must be a positive integer");
  return Math.floor(parsed);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
