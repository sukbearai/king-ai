import type { KingHandoffPolicy, KingTeamSpec, KingWorkflowObjectType } from "./team-workflow.js";

/**
 * The minimal shape of a workflow card the router reasons about. Kept structural (not coupled to
 * the ledger record type) so the engine stays a pure function of team policy + card state.
 */
export interface RoutableCard {
  id: string;
  kind: KingWorkflowObjectType;
  status: string;
  ownerRole?: string;
  reviewerRole?: string;
  handoffPolicy?: KingHandoffPolicy;
  sourceId?: string;
  sourceOwnerRole?: string;
  result?: string;
}

export interface HandoffCard {
  kind: KingWorkflowObjectType;
  title: string;
  status: string;
  ownerRole?: string;
  reviewerRole?: string;
  targetRole?: string;
  sourceId: string;
  dependsOn: string[];
  decisionBy?: string;
  detail: string;
  handoffPolicy?: KingHandoffPolicy;
}

export interface HandoffAction {
  reason: "review" | "human-escalation" | "next-role";
  card: HandoffCard;
}

export type ReviewVerdict = "approved" | "changes_requested";

/**
 * Resolve the handoff policy that governs a card: an explicit policy on the card wins, otherwise the
 * owning role's policy from the team spec.
 */
export function roleHandoffPolicy(team: KingTeamSpec, roleId: string | undefined): KingHandoffPolicy | undefined {
  if (!roleId) return undefined;
  const role = team.roles.find((entry) => entry.id === roleId) ?? team.roles.find((entry) => entry.template === roleId);
  return role?.handoffPolicy;
}

/**
 * Capability-first owner selection: pick the role whose declared capabilities best overlap the work's
 * required capabilities. Returns undefined when routing is not capability-first or nothing matches,
 * leaving the caller to fall back to an explicit owner.
 */
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

/**
 * Given a card that has just reached `done`, compute the follow-up workflow cards the team policy
 * requires. This is what turns routingPolicy/handoffPolicy from declared data into an executed
 * workflow: completing a builder card routes to its reviewer, an ops/human-gated card escalates to a
 * decision, and a card with a `nextRole` hands off down the chain.
 *
 * Returns an empty list when no routing applies (not done, a decision being resolved, or no policy).
 */
export function planHandoff(card: RoutableCard, team: KingTeamSpec): HandoffAction[] {
  if (card.status !== "done") return [];
  // Resolving a decision must never spawn another decision/review, or the gate would never close.
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
        // Carry the onward policy so completing the review continues the chain without re-triggering
        // another review.
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
