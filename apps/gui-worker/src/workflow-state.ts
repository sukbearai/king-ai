import {
  kanbanColumnFromWorkflowStatus,
  mergeWorkflowCards,
  taskDoneTransition,
  workflowAgendaLines,
  workflowCardFromKanban,
  workflowCardFromTask,
  workflowReadiness,
  type WorkflowCard,
  type WorkflowTaskLike
} from "@suwujs/king-ai/workflow-core";
import type { WakeResolveContext } from "./runtime-helpers.js";

export type GuiTaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed" | "blocked";

export type GuiKanbanColumn = "todo" | "doing" | "done";

export interface GuiKanbanCardLike {
  id: string;
  title: string;
  column: GuiKanbanColumn;
  assignee?: string;
  claimedBy?: string;
  allowedPaths?: string[];
  created_at?: number;
}

export interface GuiKanbanCreateInput {
  id?: string;
  title: string;
  assignee?: string;
  column?: GuiKanbanColumn;
  allowedPaths?: string[];
}

export interface GuiTaskLike extends WorkflowTaskLike {
  status: string;
  priority?: number;
  description?: string;
  parentId?: string;
  blockedBy?: string[];
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scope?: { paths?: string[]; patterns?: string[] };
  executionProfile?: string;
  conversationId?: string;
  requestMessageId?: string;
  coordinatorAgentId?: string;
  reviewerAgentId?: string;
  reviewResult?: "approved" | "changes_requested";
  revisionReason?: string;
  artifactIds?: string[];
  reviewedByAgentId?: string;
  reviewedAt?: number;
  created_at?: number;
  updated_at?: number;
}

export interface GuiTaskCreateInput {
  id?: string;
  title: string;
  description?: string;
  status?: GuiTaskStatus;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority?: number;
  parentId?: string;
  dependsOn?: string[];
  blockedBy?: string[];
  acceptance?: string[];
  result?: string;
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scope?: { paths?: string[]; patterns?: string[] };
  executionProfile?: string;
  conversationId?: string;
  requestMessageId?: string;
  coordinatorAgentId?: string;
  reviewerAgentId?: string;
}

export interface GuiTaskDoneOptions {
  actorId: string;
  coordinatorId: string;
  reviewerId?: string;
  hasConversation: boolean;
  resultText?: string;
  now?: number;
}

export interface GuiTaskDoneResult {
  previousStatus: GuiTaskStatus;
  statusChanged: boolean;
  outcome: "review" | "done";
}

export interface GuiTaskChangesRequestedOptions {
  actorId: string;
  workerId: string;
  reason: string;
  artifactIds?: string[];
  now?: number;
}

export function newGuiTaskId(now = Date.now()): string {
  return `task-${now}-${Math.random().toString(36).slice(2)}`;
}

export function newGuiKanbanId(now = Date.now()): string {
  return `card-${now}-${Math.random().toString(36).slice(2)}`;
}

export function createGuiKanbanDraft(input: GuiKanbanCreateInput, now = Date.now()): GuiKanbanCardLike {
  const assignee = input.assignee?.trim() || undefined;
  return {
    id: input.id ?? newGuiKanbanId(now),
    title: input.title.trim(),
    column: input.column ?? "todo",
    assignee,
    allowedPaths: input.allowedPaths?.length ? [...input.allowedPaths] : undefined,
    created_at: now
  };
}

export function applyWorkflowPatchToGuiKanban(card: GuiKanbanCardLike, patch: Partial<WorkflowCard>): void {
  if (patch.title !== undefined) card.title = String(patch.title).trim() || card.title;
  if (patch.status !== undefined) card.column = kanbanColumnFromWorkflowStatus(String(patch.status));
  if (patch.assignee !== undefined) {
    card.assignee = patch.assignee || undefined;
    if (patch.assignee) card.claimedBy = patch.assignee;
    else card.claimedBy = undefined;
  }
}

export function applyGuiKanbanClaim(card: GuiKanbanCardLike, owner: string): void {
  const actor = owner.trim();
  card.claimedBy = actor;
  card.assignee = actor;
  card.column = "doing";
}

export function applyGuiKanbanRelease(card: GuiKanbanCardLike): void {
  card.claimedBy = undefined;
}

export function applyGuiKanbanMove(
  card: GuiKanbanCardLike,
  column: GuiKanbanColumn,
  options?: { owner?: string; clearClaimOnDone?: boolean }
): void {
  card.column = column;
  if (options?.owner?.trim()) {
    const owner = options.owner.trim();
    card.assignee = owner;
    card.claimedBy = owner;
  }
  if (column === "done" && options?.clearClaimOnDone !== false) card.claimedBy = undefined;
}

export function createGuiTaskDraft(input: GuiTaskCreateInput, now = Date.now()): GuiTaskLike {
  const assignee = input.assignee?.trim() || undefined;
  return {
    id: input.id ?? newGuiTaskId(now),
    title: input.title.trim(),
    description: input.description?.trim() || undefined,
    status: input.status ?? (assignee ? "assigned" : "pending"),
    assignee,
    ownerRole: input.ownerRole?.trim() || undefined,
    reviewerRole: input.reviewerRole?.trim() || undefined,
    priority: input.priority ?? 5,
    parentId: input.parentId,
    dependsOn: input.dependsOn?.length ? [...input.dependsOn] : undefined,
    blockedBy: input.blockedBy?.length ? [...input.blockedBy] : undefined,
    acceptance: input.acceptance?.length ? [...input.acceptance] : undefined,
    result: input.result?.trim() || undefined,
    initiativeId: input.initiativeId,
    capsuleId: input.capsuleId,
    subsystem: input.subsystem,
    scope: input.scope,
    executionProfile: input.executionProfile,
    conversationId: input.conversationId,
    requestMessageId: input.requestMessageId,
    coordinatorAgentId: input.coordinatorAgentId,
    reviewerAgentId: input.reviewerAgentId,
    created_at: now,
    updated_at: now
  };
}

export function guiTaskToWorkflowCard(task: GuiTaskLike): WorkflowCard {
  return workflowCardFromTask(task);
}

export function workflowStatusToGuiTaskStatus(status: string): GuiTaskStatus {
  if (status === "open") return "pending";
  if (status === "waiting_human") return "review";
  if (status === "cancelled") return "failed";
  if (status === "pending" || status === "assigned" || status === "in_progress" || status === "review" || status === "done" || status === "failed" || status === "blocked") {
    return status;
  }
  return "pending";
}

export interface GuiTaskWritePatch extends Partial<WorkflowCard> {
  description?: string;
  priority?: number;
  parentId?: string;
  blockedBy?: string[];
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scope?: { paths?: string[]; patterns?: string[] };
  executionProfile?: string;
  conversationId?: string;
  requestMessageId?: string;
  coordinatorAgentId?: string;
  reviewerAgentId?: string;
  reviewResult?: "approved" | "changes_requested";
  revisionReason?: string;
  artifactIds?: string[];
  reviewedByAgentId?: string;
  reviewedAt?: number;
}

export interface GuiTaskWriteResult {
  previousStatus: GuiTaskStatus;
  statusChanged: boolean;
}

export function applyGuiTaskWritePatch(task: GuiTaskLike, patch: GuiTaskWritePatch, now = Date.now()): void {
  const {
    description,
    priority,
    parentId,
    blockedBy,
    initiativeId,
    capsuleId,
    subsystem,
    scope,
    executionProfile,
    conversationId,
    requestMessageId,
    coordinatorAgentId,
    reviewerAgentId,
    reviewResult,
    revisionReason,
    artifactIds,
    reviewedByAgentId,
    reviewedAt,
    ...workflowPatch
  } = patch;
  applyWorkflowPatchToGuiTask(task, workflowPatch, now);
  if (description !== undefined) task.description = description.trim() || undefined;
  if (priority !== undefined) task.priority = priority;
  if (parentId !== undefined) task.parentId = parentId || undefined;
  if (blockedBy !== undefined) task.blockedBy = blockedBy.length ? [...blockedBy] : undefined;
  if (initiativeId !== undefined) task.initiativeId = initiativeId || undefined;
  if (capsuleId !== undefined) task.capsuleId = capsuleId || undefined;
  if (subsystem !== undefined) task.subsystem = subsystem || undefined;
  if (scope !== undefined) task.scope = scope;
  if (executionProfile !== undefined) task.executionProfile = executionProfile || undefined;
  if (conversationId !== undefined) task.conversationId = conversationId || undefined;
  if (requestMessageId !== undefined) task.requestMessageId = requestMessageId || undefined;
  if (coordinatorAgentId !== undefined) task.coordinatorAgentId = coordinatorAgentId || undefined;
  if (reviewerAgentId !== undefined) task.reviewerAgentId = reviewerAgentId || undefined;
  if (reviewResult !== undefined) task.reviewResult = reviewResult;
  if (revisionReason !== undefined) task.revisionReason = revisionReason.trim() || undefined;
  if (artifactIds !== undefined) task.artifactIds = artifactIds.length ? [...artifactIds] : undefined;
  if (reviewedByAgentId !== undefined) task.reviewedByAgentId = reviewedByAgentId || undefined;
  if (reviewedAt !== undefined) task.reviewedAt = reviewedAt;
}

export function addGuiTaskToState(state: { tasks: GuiTaskLike[] }, input: GuiTaskCreateInput, now = Date.now()): GuiTaskLike {
  const task = createGuiTaskDraft(input, now);
  state.tasks.push(task);
  return task;
}

export function updateGuiTaskFromPatch(task: GuiTaskLike, patch: GuiTaskWritePatch, now = Date.now()): GuiTaskWriteResult {
  const previousStatus = workflowStatusToGuiTaskStatus(task.status);
  applyGuiTaskWritePatch(task, patch, now);
  const nextStatus = workflowStatusToGuiTaskStatus(task.status);
  return {
    previousStatus,
    statusChanged: previousStatus !== nextStatus
  };
}

export function applyWorkflowPatchToGuiTask(task: GuiTaskLike, patch: Partial<WorkflowCard>, now = Date.now()): void {
  if (patch.title !== undefined) task.title = String(patch.title).trim() || task.title;
  if (patch.status !== undefined) task.status = workflowStatusToGuiTaskStatus(String(patch.status));
  if (patch.assignee !== undefined) task.assignee = patch.assignee || undefined;
  if (patch.ownerRole !== undefined) task.ownerRole = patch.ownerRole || undefined;
  if (patch.reviewerRole !== undefined) task.reviewerRole = patch.reviewerRole || undefined;
  if (patch.dependsOn !== undefined) task.dependsOn = [...patch.dependsOn];
  if (patch.acceptance !== undefined) task.acceptance = [...patch.acceptance];
  if (patch.result !== undefined) task.result = patch.result || undefined;
  task.updated_at = now;
}

export function applyGuiTaskDone(task: GuiTaskLike, options: GuiTaskDoneOptions): GuiTaskDoneResult {
  const now = options.now ?? Date.now();
  const previousStatus = workflowStatusToGuiTaskStatus(task.status);
  if (options.resultText?.trim()) task.result = options.resultText.trim();
  const transition = taskDoneTransition(guiTaskToWorkflowCard(task), options.actorId, {
    coordinatorId: options.coordinatorId,
    reviewerId: options.reviewerId,
    hasConversation: options.hasConversation
  });
  task.status = transition.status === "review" ? "review" : "done";
  task.assignee = transition.assignee;
  if (transition.reviewResult) {
    task.reviewResult = transition.reviewResult;
    task.reviewedByAgentId = transition.reviewedBy;
    task.reviewedAt = now;
  }
  if (task.status === "review" && options.reviewerId) task.reviewerAgentId = options.reviewerId;
  task.updated_at = now;
  return {
    previousStatus,
    statusChanged: previousStatus !== task.status,
    outcome: task.status === "review" ? "review" : "done"
  };
}

export function applyGuiTaskChangesRequested(task: GuiTaskLike, options: GuiTaskChangesRequestedOptions): GuiTaskStatus {
  const now = options.now ?? Date.now();
  const previousStatus = workflowStatusToGuiTaskStatus(task.status);
  task.reviewResult = "changes_requested";
  task.revisionReason = options.reason;
  if (options.artifactIds?.length) task.artifactIds = [...options.artifactIds];
  task.reviewedByAgentId = options.actorId;
  task.reviewedAt = now;
  task.status = "assigned";
  task.assignee = options.workerId;
  task.updated_at = now;
  return previousStatus;
}

export function doneTaskIds(tasks: Array<{ id: string; status: string }>): string[] {
  return tasks.filter((row) => row.status === "done").map((row) => row.id);
}

export function taskWorkflowStatus(task: GuiTaskLike, doneTaskIds: string[]): string {
  if (task.status === "done") return "done";
  const readiness = workflowReadiness(guiTaskToWorkflowCard(task), doneTaskIds);
  return readiness.blockedBy.length > 0 ? "blocked" : task.status;
}

export function listGuiWorkflowCards(args: {
  tasks: GuiTaskLike[];
  kanban: GuiKanbanCardLike[];
}): WorkflowCard[] {
  return [
    ...args.tasks.map((task) => guiTaskToWorkflowCard(task)),
    ...args.kanban.map((card) => workflowCardFromKanban(card))
  ];
}

export function mergeGuiAndHostWorkflowCards(guiCards: WorkflowCard[], hostCards: WorkflowCard[]): WorkflowCard[] {
  return mergeWorkflowCards(guiCards, hostCards);
}

export function buildGuiAgendaBrief(args: {
  agentId: string;
  tasks: GuiTaskLike[];
  cards: GuiKanbanCardLike[];
  calendar: GuiCalendarItemLike[];
  doneTaskIds: string[];
  now?: Date;
  cronMatches?: (cron: string, now: Date) => boolean;
}) {
  return workflowAgendaLines({
    agentId: args.agentId,
    tasks: args.tasks,
    kanban: args.cards,
    calendar: args.calendar,
    doneTaskIds: args.doneTaskIds,
    taskStatusFor: (task) => taskWorkflowStatus(task as GuiTaskLike, args.doneTaskIds),
    now: args.now,
    cronMatches: args.cronMatches
  });
}

export interface GuiCalendarItemLike {
  id: string;
  title: string;
  assignee?: string;
  at: string;
  cron?: string;
  prompt?: string;
}

export function wakeResolveContextFromState(state: {
  agents: Array<{ id: string }>;
  cards: GuiKanbanCardLike[];
  tasks: Array<{ id: string; assignee?: string }>;
  conversations: Array<{ id: string; coordinatorAgentId?: string; teamMode?: "single" | "team" | "custom"; kind?: "direct" | "group" }>;
  defaultConversationId: string;
  defaultCoordinatorAgentId: string;
}): WakeResolveContext {
  const dev = state.agents.find((agent) => agent.id === "dev");
  const fallback = state.agents.find((agent) => agent.id === state.defaultCoordinatorAgentId) ?? state.agents[0];
  return {
    defaultConversationId: state.defaultConversationId,
    defaultCoordinatorAgentId: state.defaultCoordinatorAgentId,
    defaultWorkerAgentId: dev?.id ?? fallback?.id ?? state.defaultCoordinatorAgentId,
    fallbackAgentId: fallback?.id ?? state.defaultCoordinatorAgentId,
    cards: state.cards,
    tasks: state.tasks,
    conversations: state.conversations
  };
}
