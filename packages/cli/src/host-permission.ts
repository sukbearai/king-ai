import {
  checkTeamPermission,
  defaultTeamSpec,
  normalizeTeamRoleId,
  type KingTeamPermissionAction,
  type KingTeamPermissionRule,
  type KingTeamSpec
} from "./team-workflow.js";

export interface HostPermissionRequest {
  actorRole?: string;
}

export interface HostPermissionDeps {
  teamSpec?: () => KingTeamSpec | null | undefined;
  env?: NodeJS.ProcessEnv;
}

export interface HostPermissionOutcome {
  enforced: boolean;
  role?: string;
  action: KingTeamPermissionAction | null;
  decision?: "allow" | "deny" | "human-decision";
  rule?: KingTeamPermissionRule;
}

/**
 * Map an allowlisted host command (and its input) to the team governance action it represents.
 * Returns null when the command has no role-governance concern (read-only, observability, or run
 * lifecycle plumbing already gated by other policy).
 */
const PERMISSION_ACTIONS: KingTeamPermissionAction[] = [
  "assign-task",
  "claim-task",
  "create-artifact",
  "create-decision",
  "approve-decision",
  "close-task",
  "change-scope",
  "deploy-release",
  "view-audit",
  "manage-queue",
  "view-cost"
];

export function hostCommandPermissionAction(command: string, input?: unknown): KingTeamPermissionAction | null {
  // An explicit, valid `permissionAction` on the input is authoritative — callers that know their
  // intent can opt out of the heuristic inference below. It can only tighten authorization (the
  // action is still checked against the role policy), never bypass it.
  const explicit = explicitPermissionAction(input);
  if (explicit) return explicit;
  switch (command) {
    case "timeline":
      return "view-audit";
    case "usage":
    case "expenses":
      return "view-cost";
    case "task-create":
    case "initiative-create":
    case "handoff-create":
    case "capsule-create":
      return "assign-task";
    case "task-update":
      return ledgerMutationAction(input);
    case "capsule-update":
      return "claim-task";
    case "artifact-create":
    case "review-create":
      return "create-artifact";
    case "decision-create":
      return "create-decision";
    case "workflow-create":
      return workflowCreateAction(input);
    case "workflow-update":
      return workflowUpdateAction(input);
    case "submit-run":
    case "cancel-run":
    case "update-run":
    case "compact-ledger":
      return "manage-queue";
    case "execute-run":
      return "deploy-release";
    case "export":
      return "create-artifact";
    default:
      return null;
  }
}

export function resolveActorRole(request: HostPermissionRequest, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return cleanString(request.actorRole) ?? cleanString(env.KING_AI_TEAM_ROLE);
}

export function resolveTeamSpec(deps: HostPermissionDeps = {}): KingTeamSpec {
  const provided = deps.teamSpec?.();
  if (provided) return provided;
  const raw = (deps.env ?? process.env).KING_AI_TEAM_SPEC;
  if (raw && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isTeamSpec(parsed)) return parsed;
    } catch {
      // fall through to the built-in default team spec
    }
  }
  return defaultTeamSpec();
}

/**
 * Evaluate whether `request.actorRole` may run `command` under the team governance policy.
 * Governance is opt-in: when no role is resolved (request field or KING_AI_TEAM_ROLE), trusted local
 * automation proceeds exactly as before. This is not the host security boundary.
 */
export function evaluateHostCommandPermission(command: string, input: unknown, request: HostPermissionRequest, deps: HostPermissionDeps = {}): HostPermissionOutcome {
  const role = resolveActorRole(request, deps.env ?? process.env);
  if (!role) return { enforced: false, action: null };
  const action = hostCommandPermissionAction(command, input);
  if (!action) return { enforced: false, role, action: null };
  const team = resolveTeamSpec(deps);
  const normalizedRole = normalizeTeamRoleId(role);
  const result = checkTeamPermission(team, normalizedRole, action);
  return { enforced: true, role: normalizedRole, action, decision: result.decision, rule: result.rule };
}

export interface HumanApprovalOutcome {
  approved: boolean;
  approver?: string;
  reason?: string;
}

/**
 * Evaluate a human-decision marker supplied on a re-issued command. The marker is only valid when
 * `approvedBy` is present AND differs from the requesting role, so a role cannot clear its own
 * governance gate by simply setting `humanApproved=true`. This is still an automation-friendly
 * governance/audit control, not a cryptographic identity check.
 */
export function resolveHumanApproval(input: unknown, requesterRole?: string): HumanApprovalOutcome {
  if (!input || typeof input !== "object") return { approved: false, reason: "no approval provided" };
  const record = input as { humanApproved?: unknown; humanDecision?: unknown; approvedBy?: unknown };
  const flagged = record.humanApproved === true || record.humanDecision === "approved";
  if (!flagged) return { approved: false, reason: "set humanApproved=true to grant approval" };
  const approver = cleanString(record.approvedBy);
  if (!approver) return { approved: false, reason: "approvedBy is required (the human or role granting approval)" };
  if (requesterRole && approver === requesterRole) {
    return { approved: false, approver, reason: "approver must differ from the requesting role" };
  }
  return { approved: true, approver };
}

function explicitPermissionAction(input: unknown): KingTeamPermissionAction | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as { permissionAction?: unknown }).permissionAction;
  return typeof value === "string" && (PERMISSION_ACTIONS as string[]).includes(value)
    ? value as KingTeamPermissionAction
    : null;
}

function ledgerMutationAction(input: unknown): KingTeamPermissionAction {
  const status = stringField(input, "status");
  if (status === "done" || status === "cancelled") return "close-task";
  if (hasField(input, "acceptance") || hasField(input, "dependsOn")) return "change-scope";
  return "claim-task";
}

function workflowCreateAction(input: unknown): KingTeamPermissionAction {
  switch (stringField(input, "kind")) {
    case "decision":
      return "create-decision";
    case "artifact":
    case "review":
      return "create-artifact";
    default:
      return "assign-task";
  }
}

function workflowUpdateAction(input: unknown): KingTeamPermissionAction {
  const id = stringField(input, "id") ?? "";
  const kind = stringField(input, "kind");
  if (kind === "decision" || id.startsWith("decision-") || id.startsWith("decision:")) return "approve-decision";
  if (hasField(input, "acceptance") || hasField(input, "dependsOn")) return "change-scope";
  const status = stringField(input, "status");
  if (status === "done" || status === "cancelled") return "close-task";
  return "claim-task";
}

function isTeamSpec(value: unknown): value is KingTeamSpec {
  if (!value || typeof value !== "object") return false;
  const record = value as KingTeamSpec;
  return typeof record.id === "string"
    && Array.isArray(record.roles)
    && Boolean(record.permissionPolicy)
    && Array.isArray(record.permissionPolicy.rules);
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  return cleanString((input as Record<string, unknown>)[key]);
}

function hasField(input: unknown, key: string): boolean {
  return Boolean(input && typeof input === "object" && (input as Record<string, unknown>)[key] !== undefined);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
