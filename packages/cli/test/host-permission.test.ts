import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHostCommand } from "../src/host-control.js";
import { evaluateHostCommandPermission, hostCommandPermissionAction, resolveTeamSpec } from "../src/host-permission.js";

test("hostCommandPermissionAction maps commands to team permission actions", () => {
  assert.equal(hostCommandPermissionAction("timeline"), "view-audit");
  assert.equal(hostCommandPermissionAction("usage"), "view-cost");
  assert.equal(hostCommandPermissionAction("expenses"), "view-cost");
  assert.equal(hostCommandPermissionAction("task-create"), "assign-task");
  assert.equal(hostCommandPermissionAction("submit-run"), "manage-queue");
  assert.equal(hostCommandPermissionAction("execute-run"), "deploy-release");
  assert.equal(hostCommandPermissionAction("decision-create"), "create-decision");
  assert.equal(hostCommandPermissionAction("artifact-create"), "create-artifact");
  assert.equal(hostCommandPermissionAction("task-update", { status: "done" }), "close-task");
  assert.equal(hostCommandPermissionAction("task-update", { acceptance: ["x"] }), "change-scope");
  assert.equal(hostCommandPermissionAction("task-update", { status: "in_progress" }), "claim-task");
  assert.equal(hostCommandPermissionAction("workflow-update", { id: "decision-1", status: "done" }), "approve-decision");
  assert.equal(hostCommandPermissionAction("compact-ledger"), "manage-queue");
  assert.equal(hostCommandPermissionAction("status"), null);
  assert.equal(hostCommandPermissionAction("agenda"), null);
});

test("hostCommandPermissionAction honors an explicit, valid permissionAction override", () => {
  // Explicit intent wins over the heuristic inference.
  assert.equal(hostCommandPermissionAction("task-update", { status: "in_progress", permissionAction: "change-scope" }), "change-scope");
  // An unknown action is ignored and inference applies.
  assert.equal(hostCommandPermissionAction("task-update", { status: "done", permissionAction: "not-a-real-action" }), "close-task");
});

test("evaluateHostCommandPermission stays unenforced without a role", () => {
  const outcome = evaluateHostCommandPermission("export", {}, {}, { env: {} });
  assert.equal(outcome.enforced, false);
  assert.equal(outcome.action, null);
});

test("evaluateHostCommandPermission applies the default-deny team policy", () => {
  // builder may claim and create artifacts, but not view cost or deploy.
  const allowed = evaluateHostCommandPermission("artifact-create", {}, { actorRole: "builder" }, { env: {} });
  assert.equal(allowed.enforced, true);
  assert.equal(allowed.decision, "allow");

  const devAlias = evaluateHostCommandPermission("artifact-create", {}, { actorRole: "dev" }, { env: {} });
  assert.equal(devAlias.role, "builder");
  assert.equal(devAlias.decision, "allow");

  const deniedCost = evaluateHostCommandPermission("usage", {}, { actorRole: "builder" }, { env: {} });
  assert.equal(deniedCost.decision, "deny");

  const deniedDeploy = evaluateHostCommandPermission("execute-run", {}, { actorRole: "builder" }, { env: {} });
  assert.equal(deniedDeploy.decision, "deny");

  // ops can deploy, but it requires a human decision.
  const opsDeploy = evaluateHostCommandPermission("execute-run", {}, { actorRole: "ops" }, { env: {} });
  assert.equal(opsDeploy.decision, "human-decision");
});

test("evaluateHostCommandPermission honors KING_TEAM_ROLE env fallback", () => {
  const outcome = evaluateHostCommandPermission("usage", {}, {}, { env: { KING_TEAM_ROLE: "reviewer" } });
  assert.equal(outcome.enforced, true);
  assert.equal(outcome.role, "reviewer");
  assert.equal(outcome.decision, "allow");
});

test("resolveTeamSpec parses a valid KING_TEAM_SPEC and falls back when invalid", () => {
  const custom = resolveTeamSpec({
    env: {
      KING_TEAM_SPEC: JSON.stringify({
        id: "custom",
        name: "Custom",
        roles: [],
        routingPolicy: { defaultMode: "one-of-us", capabilityFirst: true, reviewRequiredFor: [], humanDecisionFor: [] },
        permissionPolicy: { defaultDecision: "deny", rules: [{ role: "builder", allow: ["view-cost"] }] }
      })
    }
  });
  assert.equal(custom.id, "custom");
  assert.equal(custom.permissionPolicy.rules[0]?.allow.includes("view-cost"), true);

  const fallback = resolveTeamSpec({ env: { KING_TEAM_SPEC: "not json" } });
  assert.equal(fallback.id, "default-team");
});

test("runHostCommand denies a role-forbidden command end to end", async () => {
  const result = await runHostCommand({ command: "usage", actorRole: "builder" }, {
    readState: async () => null,
    tokenBudget: () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 77);
  assert.match(result.text, /role governance blocked builder from view-cost/);
  assert.equal((result.json as { permission?: { decision?: string } }).permission?.decision, "deny");
});

test("runHostCommand skips role enforcement for trusted internal calls", async () => {
  const result = await runHostCommand({ command: "usage", actorRole: "builder" }, {
    readState: async () => null,
    tokenBudget: () => null,
    enforcePermission: false
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
});

test("runHostCommand escalates a human-decision command into a decision card and audit trail", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-permission-"));
  const outputDir = join(root, "out");
  const timelinePath = join(root, "host-events.ndjson");
  const runsPath = join(root, "host-runs.ndjson");

  // ops execute-run hits opt-in human-decision governance: the gate creates a decision card and blocks.
  const blocked = await runHostCommand({
    command: "execute-run",
    actorRole: "ops",
    input: { id: "missing", outputDir }
  }, {
    runsPath,
    timelinePath,
    recordTimeline: true,
    now: () => new Date("2026-06-04T00:00:00.000Z")
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 75);
  assert.match(blocked.text, /human decision marker required before execute-run/);
  const decision = (blocked.json as { decision?: { id?: string; kind?: string; status?: string; ownerRole?: string } }).decision;
  assert.equal(decision?.kind, "decision");
  assert.equal(decision?.status, "waiting_human");
  assert.equal(decision?.ownerRole, "ops");

  // The decision is persisted to the workflow ledger.
  const cards = await runHostCommand({ command: "workflow-list", input: { outputDir, kind: "decision" } });
  assert.equal((cards.json as { cards?: Array<{ id?: string }> }).cards?.some((card) => card.id === decision?.id), true);

  // The audit timeline records who acted and that it was blocked.
  const timeline = await runHostCommand({ command: "timeline", input: { limit: 5 } }, { timelinePath });
  assert.match(timeline.text, /execute-run failed exit=75 role=ops/);

  // Self-approval is rejected: the requesting role cannot approve its own human-decision gate.
  const selfApproved = await runHostCommand({
    command: "execute-run",
    actorRole: "ops",
    input: { id: "missing", outputDir, humanApproved: true, approvedBy: "ops" }
  }, {
    runsPath,
    now: () => new Date("2026-06-04T00:00:01.000Z")
  });
  assert.equal(selfApproved.exitCode, 75);
  assert.match(selfApproved.text, /approver must differ from the requesting role/);

  // With approval from a different identity, the same role may proceed (here it fails only because the request id is missing).
  const approved = await runHostCommand({
    command: "execute-run",
    actorRole: "ops",
    input: { id: "missing", outputDir, humanApproved: true, approvedBy: "human" }
  }, {
    runsPath,
    now: () => new Date("2026-06-04T00:00:02.000Z")
  });
  assert.notEqual(approved.exitCode, 75);
  assert.doesNotMatch(approved.text, /human decision marker required/);
});

test("runHostCommand gates decision approval behind approve-decision permission", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-host-permission-approve-"));
  const outputDir = join(root, "out");

  await runHostCommand({
    command: "decision-create",
    input: { outputDir, id: "decision-ship", title: "Ship release?", ownerRole: "ops" }
  }, {
    now: () => new Date("2026-06-04T00:00:00.000Z")
  });

  // builder lacks approve-decision and cannot resolve the decision card.
  const denied = await runHostCommand({
    command: "workflow-update",
    actorRole: "builder",
    input: { outputDir, id: "decision-ship", status: "done", result: "approved" }
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.exitCode, 77);
  assert.match(denied.text, /approve-decision/);

  // reviewer may resolve it.
  const approved = await runHostCommand({
    command: "workflow-update",
    actorRole: "reviewer",
    input: { outputDir, id: "decision-ship", status: "done", result: "approved" }
  }, {
    now: () => new Date("2026-06-04T00:00:01.000Z")
  });
  assert.equal(approved.ok, true);
  assert.equal((approved.json as { card?: { status?: string } }).card?.status, "done");

  await readFile(join(outputDir, "workflow.jsonl"), "utf8");
});
