import { join, resolve } from "node:path";
import { appendJsonl, compactJsonl, readJsonl, type CompactJsonlResult } from "./jsonl.js";
import type { KingHandoffPolicy, KingWorkflowObjectType } from "./team-workflow.js";
import {
  workflowCardFromCapsule,
  workflowCardFromTask,
  workflowReadiness,
  type WorkflowCard,
  type WorkflowCapsuleLike,
} from "./workflow-core.js";

export type HostTaskStatus = "pending" | "in_progress" | "blocked" | "done" | "cancelled";
export type HostCapsuleStatus = "open" | "in_review" | "accepted" | "abandoned";
export type HostWorkflowStatus =
  | "open"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "review"
  | "waiting_human"
  | "done"
  | "cancelled";

export interface HostLedgerPathInput {
  outputDir?: string;
  tasksFile?: string;
  capsulesFile?: string;
  workflowFile?: string;
}

export interface HostTaskCreateInput extends HostLedgerPathInput {
  id?: string;
  title: string;
  status?: HostTaskStatus;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority?: string;
  dependsOn?: string[];
  capsuleId?: string;
  acceptance?: string[];
  detail?: string;
}

export interface HostTaskUpdateInput extends HostLedgerPathInput {
  id: string;
  status?: HostTaskStatus;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority?: string;
  dependsOn?: string[];
  capsuleId?: string;
  acceptance?: string[];
  detail?: string;
  result?: string;
}

export interface HostTaskListInput extends HostLedgerPathInput {
  status?: HostTaskStatus;
  assignee?: string;
  limit?: number;
}

export interface HostAgendaInput extends HostLedgerPathInput {
  assignee?: string;
  limit?: number;
}

export interface HostCapsuleCreateInput extends HostLedgerPathInput {
  id?: string;
  taskId?: string;
  goal: string;
  owner: string;
  branchOrWorktree: string;
  allowedPaths: string[];
  acceptance: string[];
  reviewer: string;
  verificationCommands: string[];
  status?: HostCapsuleStatus;
}

export interface HostCapsuleUpdateInput extends HostLedgerPathInput {
  id: string;
  taskId?: string;
  goal?: string;
  owner?: string;
  branchOrWorktree?: string;
  allowedPaths?: string[];
  acceptance?: string[];
  reviewer?: string;
  verificationCommands?: string[];
  status?: HostCapsuleStatus;
}

export interface HostCapsuleListInput extends HostLedgerPathInput {
  status?: HostCapsuleStatus;
  owner?: string;
  limit?: number;
}

export interface HostTask {
  id: string;
  title: string;
  status: HostTaskStatus;
  createdAt: string;
  updatedAt?: string;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority?: string;
  dependsOn: string[];
  capsuleId?: string;
  acceptance: string[];
  detail?: string;
  result?: string;
}

export interface HostTaskUpdate {
  id: string;
  updatedAt: string;
  status?: HostTaskStatus;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority?: string;
  dependsOn?: string[];
  capsuleId?: string;
  acceptance?: string[];
  detail?: string;
  result?: string;
}

export interface HostCapsule extends WorkflowCapsuleLike {
  id: string;
  status: HostCapsuleStatus;
  createdAt: string;
  updatedAt?: string;
  taskId?: string;
  goal: string;
  owner: string;
  branchOrWorktree: string;
  allowedPaths: string[];
  acceptance: string[];
  reviewer: string;
  verificationCommands: string[];
}

export interface HostWorkflowCardCreateInput extends HostLedgerPathInput {
  kind: KingWorkflowObjectType;
  id?: string;
  title: string;
  status?: HostWorkflowStatus;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  priority?: string;
  dependsOn?: string[];
  acceptance?: string[];
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  targetRole?: string;
  decisionBy?: string;
  artifactPath?: string;
  detail?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface HostWorkflowCardUpdateInput extends HostLedgerPathInput {
  id: string;
  status?: HostWorkflowStatus;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  priority?: string;
  dependsOn?: string[];
  acceptance?: string[];
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  targetRole?: string;
  decisionBy?: string;
  artifactPath?: string;
  detail?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface HostWorkflowCardListInput extends HostLedgerPathInput {
  kind?: KingWorkflowObjectType;
  status?: HostWorkflowStatus;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  limit?: number;
}

export interface HostWorkflowCard extends WorkflowCard {
  kind: KingWorkflowObjectType;
  id: string;
  title: string;
  status: HostWorkflowStatus;
  createdAt: string;
  updatedAt?: string;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  priority?: string;
  dependsOn: string[];
  acceptance: string[];
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  targetRole?: string;
  decisionBy?: string;
  artifactPath?: string;
  detail?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface HostWorkflowCardUpdate {
  id: string;
  updatedAt: string;
  status?: HostWorkflowStatus;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  priority?: string;
  dependsOn?: string[];
  acceptance?: string[];
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  targetRole?: string;
  decisionBy?: string;
  artifactPath?: string;
  detail?: string;
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface HostCapsuleUpdate {
  id: string;
  updatedAt: string;
  status?: HostCapsuleStatus;
  taskId?: string;
  goal?: string;
  owner?: string;
  branchOrWorktree?: string;
  allowedPaths?: string[];
  acceptance?: string[];
  reviewer?: string;
  verificationCommands?: string[];
}

export interface HostAgendaTask extends HostTask {
  blockedBy: string[];
  ready: boolean;
}

export interface HostAgenda {
  tasks: HostAgendaTask[];
  readyCount: number;
  blockedCount: number;
  summary: string;
}

export function hostTasksPathForOutputDir(outputDir = "deliverables"): string {
  return join(resolve(outputDir), "tasks.jsonl");
}

export function hostCapsulesPathForOutputDir(outputDir = "deliverables"): string {
  return join(resolve(outputDir), "capsules.jsonl");
}

export function hostWorkflowPathForOutputDir(outputDir = "deliverables"): string {
  return join(resolve(outputDir), "workflow.jsonl");
}

export async function createHostTask(
  input: HostTaskCreateInput,
  now: () => Date = () => new Date(),
): Promise<HostTask> {
  const createdAt = now().toISOString();
  const task: HostTask = {
    id: safeId(input.id) ?? buildId("task", createdAt),
    title: requiredString(input.title, "task title"),
    status: normalizeTaskStatus(input.status ?? "pending"),
    createdAt,
    assignee: cleanString(input.assignee),
    ownerRole: cleanString(input.ownerRole),
    reviewerRole: cleanString(input.reviewerRole),
    priority: cleanString(input.priority),
    dependsOn: normalizeStringArray(input.dependsOn, "dependsOn"),
    capsuleId: cleanString(input.capsuleId),
    acceptance: normalizeStringArray(input.acceptance, "acceptance"),
    detail: cleanString(input.detail),
  };
  await appendJsonl(taskPath(input), task);
  return task;
}

export async function updateHostTask(
  input: HostTaskUpdateInput,
  now: () => Date = () => new Date(),
): Promise<HostTask> {
  const id = requiredId(input.id, "task id");
  const tasks = await listHostTasks({ outputDir: input.outputDir, tasksFile: input.tasksFile });
  const existing = tasks.find((task) => task.id === id);
  if (!existing) throw new Error(`host task not found: ${id}`);
  const update: HostTaskUpdate = dropUndefined({
    id,
    updatedAt: now().toISOString(),
    status: input.status === undefined ? undefined : normalizeTaskStatus(input.status),
    assignee: cleanString(input.assignee),
    ownerRole: cleanString(input.ownerRole),
    reviewerRole: cleanString(input.reviewerRole),
    priority: cleanString(input.priority),
    dependsOn: input.dependsOn === undefined ? undefined : normalizeStringArray(input.dependsOn, "dependsOn"),
    capsuleId: cleanString(input.capsuleId),
    acceptance: input.acceptance === undefined ? undefined : normalizeStringArray(input.acceptance, "acceptance"),
    detail: cleanString(input.detail),
    result: cleanString(input.result),
  });
  const next = applyTaskUpdate(existing, update);
  validateTaskUpdate(existing, next, tasks);
  await appendJsonl(taskPath(input), update);
  return next;
}

export async function listHostTasks(input: HostTaskListInput = {}): Promise<HostTask[]> {
  const status = input.status === undefined ? undefined : normalizeTaskStatus(input.status);
  const assignee = cleanString(input.assignee);
  const limit = normalizeLimit(input.limit);
  const tasks = await readMergedTasks(taskPath(input));
  const filtered = tasks.filter((task) => {
    if (status && task.status !== status) return false;
    if (assignee && task.assignee !== assignee) return false;
    return true;
  });
  return limit ? filtered.slice(-limit).reverse() : filtered;
}

export async function buildHostAgenda(input: HostAgendaInput = {}): Promise<HostAgenda> {
  const tasks = await listHostTasks(input);
  const done = new Set(
    tasks.filter((task) => task.status === "done" || task.status === "cancelled").map((task) => task.id),
  );
  const agendaTasks = tasks
    .filter((task) => task.status !== "done" && task.status !== "cancelled")
    .map((task): HostAgendaTask => {
      const { blockedBy } = workflowReadiness(workflowCardFromTask(task), done);
      return {
        ...task,
        blockedBy,
        ready: task.status !== "blocked" && blockedBy.length === 0,
      };
    });
  const ready = agendaTasks.filter((task) => task.ready);
  const blocked = agendaTasks.filter((task) => !task.ready);
  const limit = normalizeLimit(input.limit);
  const selected = limit ? agendaTasks.slice(0, limit) : agendaTasks;
  return {
    tasks: selected,
    readyCount: ready.length,
    blockedCount: blocked.length,
    summary: formatHostAgenda({ tasks: selected, readyCount: ready.length, blockedCount: blocked.length }),
  };
}

export async function createHostCapsule(
  input: HostCapsuleCreateInput,
  now: () => Date = () => new Date(),
): Promise<HostCapsule> {
  const createdAt = now().toISOString();
  const capsule: HostCapsule = {
    id: safeId(input.id) ?? buildId("capsule", createdAt),
    status: normalizeCapsuleStatus(input.status ?? "open"),
    createdAt,
    taskId: cleanString(input.taskId),
    goal: requiredString(input.goal, "capsule goal"),
    owner: requiredString(input.owner, "capsule owner"),
    branchOrWorktree: requiredString(input.branchOrWorktree, "capsule branchOrWorktree"),
    allowedPaths: requiredStringArray(input.allowedPaths, "allowedPaths"),
    acceptance: requiredStringArray(input.acceptance, "acceptance"),
    reviewer: requiredString(input.reviewer, "capsule reviewer"),
    verificationCommands: requiredStringArray(input.verificationCommands, "verificationCommands"),
  };
  await appendJsonl(capsulePath(input), capsule);
  return capsule;
}

export async function updateHostCapsule(
  input: HostCapsuleUpdateInput,
  now: () => Date = () => new Date(),
): Promise<HostCapsule> {
  const id = requiredId(input.id, "capsule id");
  const existing = (await listHostCapsules({ outputDir: input.outputDir, capsulesFile: input.capsulesFile })).find(
    (capsule) => capsule.id === id,
  );
  if (!existing) throw new Error(`host capsule not found: ${id}`);
  const update: HostCapsuleUpdate = dropUndefined({
    id,
    updatedAt: now().toISOString(),
    status: input.status === undefined ? undefined : normalizeCapsuleStatus(input.status),
    taskId: cleanString(input.taskId),
    goal: cleanString(input.goal),
    owner: cleanString(input.owner),
    branchOrWorktree: cleanString(input.branchOrWorktree),
    allowedPaths:
      input.allowedPaths === undefined ? undefined : requiredStringArray(input.allowedPaths, "allowedPaths"),
    acceptance: input.acceptance === undefined ? undefined : requiredStringArray(input.acceptance, "acceptance"),
    reviewer: cleanString(input.reviewer),
    verificationCommands:
      input.verificationCommands === undefined
        ? undefined
        : requiredStringArray(input.verificationCommands, "verificationCommands"),
  });
  const next = applyCapsuleUpdate(existing, update);
  void workflowCardFromCapsule(next);
  await appendJsonl(capsulePath(input), update);
  return next;
}

export async function listHostCapsules(input: HostCapsuleListInput = {}): Promise<HostCapsule[]> {
  const status = input.status === undefined ? undefined : normalizeCapsuleStatus(input.status);
  const owner = cleanString(input.owner);
  const limit = normalizeLimit(input.limit);
  const capsules = await readMergedCapsules(capsulePath(input));
  const filtered = capsules.filter((capsule) => {
    if (status && capsule.status !== status) return false;
    if (owner && capsule.owner !== owner) return false;
    return true;
  });
  return limit ? filtered.slice(-limit).reverse() : filtered;
}

export async function getHostCapsule(input: HostLedgerPathInput & { id: string }): Promise<HostCapsule | null> {
  const id = requiredId(input.id, "capsule id");
  return (await listHostCapsules(input)).find((capsule) => capsule.id === id) ?? null;
}

export async function createHostWorkflowCard(
  input: HostWorkflowCardCreateInput,
  now: () => Date = () => new Date(),
): Promise<HostWorkflowCard> {
  const createdAt = now().toISOString();
  const card: HostWorkflowCard = {
    kind: normalizeWorkflowKind(input.kind),
    id: safeId(input.id) ?? buildId(input.kind, createdAt),
    title: requiredString(input.title, "workflow title"),
    status: normalizeWorkflowStatus(input.status ?? defaultWorkflowStatus(input.kind)),
    createdAt,
    ownerRole: cleanString(input.ownerRole),
    reviewerRole: cleanString(input.reviewerRole),
    assignee: cleanString(input.assignee),
    priority: cleanString(input.priority),
    dependsOn: normalizeStringArray(input.dependsOn, "dependsOn"),
    acceptance: normalizeStringArray(input.acceptance, "acceptance"),
    handoffPolicy: input.handoffPolicy,
    sourceId: cleanString(input.sourceId),
    targetRole: cleanString(input.targetRole),
    decisionBy: cleanString(input.decisionBy),
    artifactPath: cleanString(input.artifactPath),
    detail: cleanString(input.detail),
    result: cleanString(input.result),
    metadata: normalizeMetadata(input.metadata),
  };
  await appendJsonl(workflowPath(input), card);
  return card;
}

export async function updateHostWorkflowCard(
  input: HostWorkflowCardUpdateInput,
  now: () => Date = () => new Date(),
): Promise<HostWorkflowCard> {
  const id = requiredId(input.id, "workflow id");
  const cards = await listHostWorkflowCards({ outputDir: input.outputDir, workflowFile: input.workflowFile });
  const existing = cards.find((card) => card.id === id);
  if (!existing) throw new Error(`host workflow card not found: ${id}`);
  const update: HostWorkflowCardUpdate = dropUndefined({
    id,
    updatedAt: now().toISOString(),
    status: input.status === undefined ? undefined : normalizeWorkflowStatus(input.status),
    ownerRole: cleanString(input.ownerRole),
    reviewerRole: cleanString(input.reviewerRole),
    assignee: cleanString(input.assignee),
    priority: cleanString(input.priority),
    dependsOn: input.dependsOn === undefined ? undefined : normalizeStringArray(input.dependsOn, "dependsOn"),
    acceptance: input.acceptance === undefined ? undefined : normalizeStringArray(input.acceptance, "acceptance"),
    handoffPolicy: input.handoffPolicy,
    sourceId: cleanString(input.sourceId),
    targetRole: cleanString(input.targetRole),
    decisionBy: cleanString(input.decisionBy),
    artifactPath: cleanString(input.artifactPath),
    detail: cleanString(input.detail),
    result: cleanString(input.result),
    metadata: normalizeMetadata(input.metadata),
  });
  const merged = applyWorkflowUpdate(existing, update);
  validateWorkflowUpdate(existing, merged, cards);
  await appendJsonl(workflowPath(input), update);
  return merged;
}

export async function listHostWorkflowCards(input: HostWorkflowCardListInput = {}): Promise<HostWorkflowCard[]> {
  const kind = input.kind === undefined ? undefined : normalizeWorkflowKind(input.kind);
  const status = input.status === undefined ? undefined : normalizeWorkflowStatus(input.status);
  const ownerRole = cleanString(input.ownerRole);
  const reviewerRole = cleanString(input.reviewerRole);
  const assignee = cleanString(input.assignee);
  const limit = normalizeLimit(input.limit);
  const cards = await readMergedWorkflowCards(workflowPath(input));
  const filtered = cards.filter((card) => {
    if (kind && card.kind !== kind) return false;
    if (status && card.status !== status) return false;
    if (ownerRole && card.ownerRole !== ownerRole) return false;
    if (reviewerRole && card.reviewerRole !== reviewerRole) return false;
    if (assignee && card.assignee !== assignee) return false;
    return true;
  });
  return limit ? filtered.slice(-limit).reverse() : filtered;
}

export function formatHostWorkflowCards(cards: HostWorkflowCard[]): string {
  if (cards.length === 0) return "no host workflow cards";
  return cards
    .map((card) => {
      const owner = card.ownerRole ? ` ownerRole=${card.ownerRole}` : "";
      const reviewer = card.reviewerRole ? ` reviewerRole=${card.reviewerRole}` : "";
      const assignee = card.assignee ? ` @${card.assignee}` : "";
      const deps = card.dependsOn.length ? ` dependsOn=${card.dependsOn.join(",")}` : "";
      const artifact = card.artifactPath ? ` artifact=${card.artifactPath}` : "";
      return `${card.id} ${card.kind} ${card.status}${assignee}${owner}${reviewer}${deps}${artifact}: ${card.title}`;
    })
    .join("\n");
}

export function formatHostTasks(tasks: HostTask[]): string {
  if (tasks.length === 0) return "no host tasks";
  return tasks
    .map((task) => {
      const deps = task.dependsOn.length ? ` dependsOn=${task.dependsOn.join(",")}` : "";
      const capsule = task.capsuleId ? ` capsule=${task.capsuleId}` : "";
      const owner = task.ownerRole ? ` ownerRole=${task.ownerRole}` : "";
      const reviewer = task.reviewerRole ? ` reviewerRole=${task.reviewerRole}` : "";
      return `${task.id} ${task.status}${task.assignee ? ` @${task.assignee}` : ""}${owner}${reviewer}${deps}${capsule}: ${task.title}`;
    })
    .join("\n");
}

export function formatHostCapsules(capsules: HostCapsule[]): string {
  if (capsules.length === 0) return "no host capsules";
  return capsules
    .map((capsule) => {
      const task = capsule.taskId ? ` task=${capsule.taskId}` : "";
      return `${capsule.id} ${capsule.status} owner=${capsule.owner} reviewer=${capsule.reviewer}${task}: ${capsule.goal}`;
    })
    .join("\n");
}

export function formatHostAgenda(agenda: Pick<HostAgenda, "tasks" | "readyCount" | "blockedCount">): string {
  const lines = [`agenda: ready=${agenda.readyCount} blocked=${agenda.blockedCount}`];
  if (agenda.tasks.length === 0) {
    lines.push("no open host tasks");
    return lines.join("\n");
  }
  for (const task of agenda.tasks) {
    const blockedBy = task.blockedBy.length ? ` blockedBy=${task.blockedBy.join(",")}` : "";
    lines.push(
      `${task.ready ? "ready" : "blocked"} ${task.id}${task.assignee ? ` @${task.assignee}` : ""}${blockedBy}: ${task.title}`,
    );
  }
  return lines.join("\n");
}

export interface HostLedgerCompactResult {
  tasks: CompactJsonlResult;
  capsules: CompactJsonlResult;
  workflow: CompactJsonlResult;
}

/**
 * Rewrite the append-only task, capsule, and workflow logs into their merged latest-state
 * snapshots. The result is observationally identical to the pre-compaction ledger but drops
 * superseded update records, bounding unbounded log growth from long multi-role runs.
 */
export async function compactHostLedger(input: HostLedgerPathInput = {}): Promise<HostLedgerCompactResult> {
  const tasks = await compactJsonl(taskPath(input), (records) => mergeTasks(records));
  const capsules = await compactJsonl(capsulePath(input), (records) => mergeCapsules(records));
  const workflow = await compactJsonl(workflowPath(input), (records) => mergeWorkflowCards(records));
  return { tasks, capsules, workflow };
}

export function formatHostLedgerCompact(result: HostLedgerCompactResult): string {
  const line = (label: string, entry: CompactJsonlResult): string =>
    `${label}: ${entry.records} -> ${entry.written} records (${entry.path})`;
  return [
    "ledger compacted",
    line("tasks", result.tasks),
    line("capsules", result.capsules),
    line("workflow", result.workflow),
  ].join("\n");
}

function taskPath(input: HostLedgerPathInput): string {
  return input.tasksFile ? resolve(input.tasksFile) : hostTasksPathForOutputDir(input.outputDir);
}

function capsulePath(input: HostLedgerPathInput): string {
  return input.capsulesFile ? resolve(input.capsulesFile) : hostCapsulesPathForOutputDir(input.outputDir);
}

function workflowPath(input: HostLedgerPathInput): string {
  return input.workflowFile ? resolve(input.workflowFile) : hostWorkflowPathForOutputDir(input.outputDir);
}

function mergeTasks(records: unknown[]): HostTask[] {
  const byId = new Map<string, HostTask>();
  for (const record of records) {
    if (isTask(record)) byId.set(record.id, record);
    else if (isTaskUpdate(record)) {
      const existing = byId.get(record.id);
      if (existing) byId.set(record.id, applyTaskUpdate(existing, record));
    }
  }
  return [...byId.values()];
}

function mergeCapsules(records: unknown[]): HostCapsule[] {
  const byId = new Map<string, HostCapsule>();
  for (const record of records) {
    if (isCapsule(record)) byId.set(record.id, record);
    else if (isCapsuleUpdate(record)) {
      const existing = byId.get(record.id);
      if (existing) byId.set(record.id, applyCapsuleUpdate(existing, record));
    }
  }
  return [...byId.values()];
}

function mergeWorkflowCards(records: unknown[]): HostWorkflowCard[] {
  const byId = new Map<string, HostWorkflowCard>();
  for (const record of records) {
    if (isWorkflowCard(record)) byId.set(record.id, record);
    else if (isWorkflowUpdate(record)) {
      const existing = byId.get(record.id);
      if (existing) byId.set(record.id, applyWorkflowUpdate(existing, record));
    }
  }
  return [...byId.values()];
}

async function readMergedTasks(path: string): Promise<HostTask[]> {
  return mergeTasks(await readJsonl(path));
}

async function readMergedCapsules(path: string): Promise<HostCapsule[]> {
  return mergeCapsules(await readJsonl(path));
}

async function readMergedWorkflowCards(path: string): Promise<HostWorkflowCard[]> {
  return mergeWorkflowCards(await readJsonl(path));
}

function applyTaskUpdate(task: HostTask, update: HostTaskUpdate): HostTask {
  return {
    ...task,
    status: update.status ?? task.status,
    assignee: update.assignee ?? task.assignee,
    ownerRole: update.ownerRole ?? task.ownerRole,
    reviewerRole: update.reviewerRole ?? task.reviewerRole,
    priority: update.priority ?? task.priority,
    dependsOn: update.dependsOn ?? task.dependsOn,
    capsuleId: update.capsuleId ?? task.capsuleId,
    acceptance: update.acceptance ?? task.acceptance,
    detail: update.detail ?? task.detail,
    result: update.result ?? task.result,
    updatedAt: update.updatedAt,
  };
}

function applyWorkflowUpdate(card: HostWorkflowCard, update: HostWorkflowCardUpdate): HostWorkflowCard {
  return {
    ...card,
    status: update.status ?? card.status,
    ownerRole: update.ownerRole ?? card.ownerRole,
    reviewerRole: update.reviewerRole ?? card.reviewerRole,
    assignee: update.assignee ?? card.assignee,
    priority: update.priority ?? card.priority,
    dependsOn: update.dependsOn ?? card.dependsOn,
    acceptance: update.acceptance ?? card.acceptance,
    handoffPolicy: update.handoffPolicy ?? card.handoffPolicy,
    sourceId: update.sourceId ?? card.sourceId,
    targetRole: update.targetRole ?? card.targetRole,
    decisionBy: update.decisionBy ?? card.decisionBy,
    artifactPath: update.artifactPath ?? card.artifactPath,
    detail: update.detail ?? card.detail,
    result: update.result ?? card.result,
    metadata: update.metadata ?? card.metadata,
    updatedAt: update.updatedAt,
  };
}

function validateTaskUpdate(existing: HostTask, next: HostTask, tasks: HostTask[]): void {
  if (next.status !== "done") return;
  const done = new Set(
    tasks
      .filter((task) => task.id !== next.id && (task.status === "done" || task.status === "cancelled"))
      .map((task) => task.id),
  );
  const readiness = workflowReadiness(workflowCardFromTask(next), done);
  if (readiness.blockedBy.length > 0)
    throw new Error(`host task ${next.id} depends on unfinished tasks: ${readiness.blockedBy.join(", ")}`);
  if (readiness.missingEvidence) throw new Error(`host task ${next.id} requires result before marking done`);
  void existing;
}

function validateWorkflowUpdate(existing: HostWorkflowCard, next: HostWorkflowCard, cards: HostWorkflowCard[]): void {
  if (next.status !== "done") return;

  const done = new Set(
    cards
      .filter((card) => card.id !== next.id && (card.status === "done" || card.status === "cancelled"))
      .map((card) => card.id),
  );
  const readiness = workflowReadiness(next, done);
  if (readiness.blockedBy.length > 0)
    throw new Error(`workflow card ${next.id} depends on unfinished workflow cards: ${readiness.blockedBy.join(", ")}`);

  if (readiness.missingEvidence)
    throw new Error(`workflow card ${next.id} requires result or artifactPath before marking done`);

  if (readiness.missingReviewVerdict)
    throw new Error(`review card ${next.id} requires result=approved or result=changes_requested before marking done`);

  void existing;
}

function applyCapsuleUpdate(capsule: HostCapsule, update: HostCapsuleUpdate): HostCapsule {
  return {
    ...capsule,
    status: update.status ?? capsule.status,
    taskId: update.taskId ?? capsule.taskId,
    goal: update.goal ?? capsule.goal,
    owner: update.owner ?? capsule.owner,
    branchOrWorktree: update.branchOrWorktree ?? capsule.branchOrWorktree,
    allowedPaths: update.allowedPaths ?? capsule.allowedPaths,
    acceptance: update.acceptance ?? capsule.acceptance,
    reviewer: update.reviewer ?? capsule.reviewer,
    verificationCommands: update.verificationCommands ?? capsule.verificationCommands,
    updatedAt: update.updatedAt,
  };
}

function isTask(value: unknown): value is HostTask {
  if (!value || typeof value !== "object") return false;
  const record = value as HostTask;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    Array.isArray(record.dependsOn) &&
    Array.isArray(record.acceptance) &&
    isTaskStatus(record.status)
  );
}

function isTaskUpdate(value: unknown): value is HostTaskUpdate {
  if (!value || typeof value !== "object") return false;
  const record = value as HostTaskUpdate;
  return typeof record.id === "string" && typeof record.updatedAt === "string" && !("title" in record);
}

function isCapsule(value: unknown): value is HostCapsule {
  if (!value || typeof value !== "object") return false;
  const record = value as HostCapsule;
  return (
    typeof record.id === "string" &&
    typeof record.goal === "string" &&
    Array.isArray(record.allowedPaths) &&
    isCapsuleStatus(record.status)
  );
}

function isCapsuleUpdate(value: unknown): value is HostCapsuleUpdate {
  if (!value || typeof value !== "object") return false;
  const record = value as HostCapsuleUpdate;
  return typeof record.id === "string" && typeof record.updatedAt === "string" && !("createdAt" in record);
}

function isWorkflowCard(value: unknown): value is HostWorkflowCard {
  if (!value || typeof value !== "object") return false;
  const record = value as HostWorkflowCard;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    isWorkflowKind(record.kind) &&
    isWorkflowStatus(record.status) &&
    Array.isArray(record.dependsOn) &&
    Array.isArray(record.acceptance)
  );
}

function isWorkflowUpdate(value: unknown): value is HostWorkflowCardUpdate {
  if (!value || typeof value !== "object") return false;
  const record = value as HostWorkflowCardUpdate;
  return typeof record.id === "string" && typeof record.updatedAt === "string" && !("kind" in record);
}

function normalizeTaskStatus(value: unknown): HostTaskStatus {
  if (isTaskStatus(value)) return value;
  throw new Error(`invalid task status: ${String(value)}`);
}

function isTaskStatus(value: unknown): value is HostTaskStatus {
  return (
    value === "pending" || value === "in_progress" || value === "blocked" || value === "done" || value === "cancelled"
  );
}

function normalizeCapsuleStatus(value: unknown): HostCapsuleStatus {
  if (isCapsuleStatus(value)) return value;
  throw new Error(`invalid capsule status: ${String(value)}`);
}

function isCapsuleStatus(value: unknown): value is HostCapsuleStatus {
  return value === "open" || value === "in_review" || value === "accepted" || value === "abandoned";
}

function normalizeWorkflowKind(value: unknown): KingWorkflowObjectType {
  if (isWorkflowKind(value)) return value;
  throw new Error(`invalid workflow kind: ${String(value)}`);
}

function isWorkflowKind(value: unknown): value is KingWorkflowObjectType {
  return (
    value === "initiative" ||
    value === "task" ||
    value === "handoff" ||
    value === "review" ||
    value === "decision" ||
    value === "artifact"
  );
}

function normalizeWorkflowStatus(value: unknown): HostWorkflowStatus {
  if (isWorkflowStatus(value)) return value;
  throw new Error(`invalid workflow status: ${String(value)}`);
}

function isWorkflowStatus(value: unknown): value is HostWorkflowStatus {
  return (
    value === "open" ||
    value === "assigned" ||
    value === "in_progress" ||
    value === "blocked" ||
    value === "review" ||
    value === "waiting_human" ||
    value === "done" ||
    value === "cancelled"
  );
}

function defaultWorkflowStatus(kind: KingWorkflowObjectType): HostWorkflowStatus {
  return kind === "decision" ? "waiting_human" : "open";
}

function normalizeLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error("limit must be a positive integer");
  return Math.floor(parsed);
}

function normalizeStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => requiredString(entry, label));
}

function requiredStringArray(value: unknown, label: string): string[] {
  const entries = normalizeStringArray(value, label);
  if (entries.length === 0) throw new Error(`${label} must include at least one entry`);
  return entries;
}

function requiredString(value: unknown, label: string): string {
  const cleaned = cleanString(value);
  if (!cleaned) throw new Error(`${label} is required`);
  return cleaned;
}

function requiredId(value: unknown, label: string): string {
  const cleaned = safeId(value);
  if (!cleaned) throw new Error(`${label} is required`);
  return cleaned;
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const cleaned = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(cleaned)) throw new Error(`invalid id: ${cleaned}`);
  return cleaned;
}

function buildId(prefix: string, iso: string): string {
  return `${prefix}-${iso.replace(/[:.]/g, "-").slice(0, 19)}`;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metadata must be an object");
  return value as Record<string, unknown>;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
