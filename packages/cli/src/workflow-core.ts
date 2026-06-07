import type { KingHandoffPolicy, KingTeamSpec, KingWorkflowObjectType } from "./team-workflow.js";

export type WorkflowStatus =
  | "open"
  | "pending"
  | "assigned"
  | "in_progress"
  | "blocked"
  | "review"
  | "waiting_human"
  | "done"
  | "cancelled"
  | "failed";

export type ReviewVerdict = "approved" | "changes_requested";

/**
 * Canonical workflow card shape shared by the GUI runtime, host JSONL ledger, and routing policy.
 * Persistence layers may keep richer records, but state transitions and handoffs should be derived
 * from this structural contract.
 */
export interface WorkflowCard {
  id: string;
  kind: KingWorkflowObjectType;
  status: WorkflowStatus | string;
  title?: string;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  sourceOwnerRole?: string;
  result?: string;
  dependsOn?: string[];
  acceptance?: string[];
  artifactPath?: string;
}

export interface WorkflowHandoffCard {
  kind: KingWorkflowObjectType;
  title: string;
  status: WorkflowStatus;
  ownerRole?: string;
  reviewerRole?: string;
  targetRole?: string;
  sourceId: string;
  dependsOn: string[];
  decisionBy?: string;
  detail: string;
  handoffPolicy?: KingHandoffPolicy;
}

export interface WorkflowHandoffAction {
  reason: "review" | "human-escalation" | "next-role";
  card: WorkflowHandoffCard;
}

export interface WorkflowTransition {
  status: WorkflowStatus;
  assignee?: string;
  reviewResult?: ReviewVerdict;
  reviewedBy?: string;
}

export interface WorkflowReadiness {
  ready: boolean;
  blockedBy: string[];
  missingEvidence: boolean;
  missingReviewVerdict: boolean;
}

export interface WorkflowTaskLike {
  id: string;
  status: string;
  title?: string;
  ownerRole?: string;
  reviewerRole?: string;
  assignee?: string;
  result?: string;
  dependsOn?: string[];
  acceptance?: string[];
  artifactPath?: string;
}

export interface WorkflowCapsuleLike {
  id: string;
  status: string;
  goal?: string;
  owner?: string;
  ownerAgent?: string;
  reviewer?: string;
  acceptance?: string[] | string;
  taskId?: string;
}

export function roleHandoffPolicy(team: KingTeamSpec, roleId: string | undefined): KingHandoffPolicy | undefined {
  if (!roleId) return undefined;
  const role = team.roles.find((entry) => entry.id === roleId) ?? team.roles.find((entry) => entry.template === roleId);
  return role?.handoffPolicy;
}

export function selectOwnerRole(team: KingTeamSpec, requiredCapabilities: string[]): string | undefined {
  if (!team.routingPolicy.capabilityFirst || requiredCapabilities.length === 0) return undefined;
  const required = new Set(requiredCapabilities);
  let best: string | undefined;
  let bestScore = 0;
  for (const role of team.roles) {
    const score = role.capabilities.reduce((count, capability) => (required.has(capability) ? count + 1 : count), 0);
    if (score > bestScore) {
      bestScore = score;
      best = role.id;
    }
  }
  return best;
}

export function normalizeReviewVerdict(result?: string): ReviewVerdict | undefined {
  const value = result?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!value) return undefined;
  if (value === "approved" || value === "approve" || value === "accepted" || value === "pass" || value === "passed") return "approved";
  if (value === "changes_requested" || value === "change_requested" || value === "rejected" || value === "needs_work" || value === "fail" || value === "failed") return "changes_requested";
  return undefined;
}

export function planHandoff(card: WorkflowCard, team: KingTeamSpec): WorkflowHandoffAction[] {
  if (card.status !== "done") return [];
  if (card.kind === "decision") return [];
  const verdict = card.kind === "review" ? normalizeReviewVerdict(card.result) : undefined;
  if (verdict === "changes_requested" && card.sourceId && card.sourceOwnerRole) {
    return [{
      reason: "next-role",
      card: {
        kind: "handoff",
        title: `Changes requested for ${card.sourceId}`,
        status: "assigned",
        ownerRole: card.sourceOwnerRole,
        targetRole: card.sourceOwnerRole,
        sourceId: card.id,
        dependsOn: [card.id],
        detail: `Review ${card.id} requested changes on ${card.sourceId}; route back to ${card.sourceOwnerRole}.`
      }
    }];
  }
  const policy = card.handoffPolicy ?? roleHandoffPolicy(team, card.ownerRole);
  if (!policy) return [];

  const reviewer = card.reviewerRole ?? policy.reviewerRole;
  const owner = card.ownerRole ?? "owner";

  if (policy.acceptanceRequired && reviewer && card.kind !== "review") {
    return [{
      reason: "review",
      card: {
        kind: "review",
        title: `Review ${card.id}`,
        status: "review",
        ownerRole: reviewer,
        reviewerRole: reviewer,
        targetRole: reviewer,
        sourceId: card.id,
        dependsOn: [card.id],
        detail: `Auto-routed for review by ${reviewer} after ${owner} completed ${card.id}.`,
        handoffPolicy: {
          mode: policy.mode,
          nextRole: policy.nextRole,
          escalation: policy.escalation,
          acceptanceRequired: false
        }
      }
    }];
  }

  if (policy.escalation === "human" || policy.mode === "human-decision") {
    return [{
      reason: "human-escalation",
      card: {
        kind: "decision",
        title: `Decision after ${card.id}`,
        status: "waiting_human",
        ownerRole: card.ownerRole,
        sourceId: card.id,
        dependsOn: [card.id],
        decisionBy: "human",
        detail: `Auto-routed: ${owner} completed ${card.id}; a human decision is required before continuing.`
      }
    }];
  }

  if (policy.nextRole) {
    return [{
      reason: "next-role",
      card: {
        kind: "handoff",
        title: `Handoff to ${policy.nextRole} after ${card.id}`,
        status: "assigned",
        ownerRole: policy.nextRole,
        targetRole: policy.nextRole,
        sourceId: card.id,
        dependsOn: [card.id],
        detail: `Auto-routed from ${owner} to ${policy.nextRole} after ${card.id}.`
      }
    }];
  }

  return [];
}

export function taskDoneTransition(card: WorkflowCard, actorId: string, options: { coordinatorId?: string; reviewerId?: string; hasConversation?: boolean } = {}): WorkflowTransition {
  if (card.status === "review" || (options.reviewerId && actorId === options.reviewerId)) {
    return {
      status: "done",
      assignee: options.coordinatorId,
      reviewResult: "approved",
      reviewedBy: actorId
    };
  }
  if (options.reviewerId) {
    return {
      status: "review",
      assignee: options.reviewerId
    };
  }
  return {
    status: "done",
    assignee: options.hasConversation ? options.coordinatorId : card.assignee
  };
}

export function dependencySatisfied(doneIds: Iterable<string>, dependencyId: string): boolean {
  for (const doneId of doneIds) {
    if (doneId === dependencyId) return true;
  }
  return false;
}

export function workflowReadiness(card: WorkflowCard, doneIds: Iterable<string>): WorkflowReadiness {
  const done = [...doneIds];
  const blockedBy = (card.dependsOn ?? []).filter((id) => !dependencySatisfied(done, id));
  const missingEvidence = (card.acceptance?.length ?? 0) > 0 && !card.result && !card.artifactPath;
  const missingReviewVerdict = card.kind === "review" && !normalizeReviewVerdict(card.result);
  return {
    ready: blockedBy.length === 0 && !missingEvidence && !missingReviewVerdict,
    blockedBy,
    missingEvidence,
    missingReviewVerdict
  };
}

export function workflowCardFromTask(task: WorkflowTaskLike): WorkflowCard {
  const card: WorkflowCard = {
    id: task.id,
    kind: "task",
    status: task.status,
    title: task.title,
    ownerRole: task.ownerRole,
    reviewerRole: task.reviewerRole,
    assignee: task.assignee,
    result: task.result,
    dependsOn: task.dependsOn,
    acceptance: task.acceptance,
    artifactPath: task.artifactPath
  };
  return dropUndefined(card);
}

export function workflowCardFromCapsule(capsule: WorkflowCapsuleLike): WorkflowCard {
  const card: WorkflowCard = {
    id: capsule.id,
    kind: "handoff",
    status: normalizeCapsuleWorkflowStatus(capsule.status),
    title: capsule.goal,
    ownerRole: capsule.owner ?? capsule.ownerAgent,
    reviewerRole: capsule.reviewer,
    sourceId: capsule.taskId,
    acceptance: Array.isArray(capsule.acceptance)
      ? capsule.acceptance
      : capsule.acceptance
        ? [capsule.acceptance]
        : undefined
  };
  return dropUndefined(card);
}

export function normalizeCapsuleWorkflowStatus(status: string): WorkflowStatus | string {
  if (status === "open") return "assigned";
  if (status === "in_review") return "review";
  if (status === "accepted" || status === "merged") return "done";
  return status;
}

function dropUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
