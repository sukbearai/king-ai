import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTeamSpec } from "../src/team-workflow.js";
import { planHandoff, roleHandoffPolicy, selectOwnerRole, type RoutableCard } from "../src/team-routing.js";

test("selectOwnerRole picks the best capability match under capability-first routing", () => {
  const team = defaultTeamSpec();
  assert.equal(selectOwnerRole(team, ["testing", "verification"]), "tester");
  assert.equal(selectOwnerRole(team, ["research", "evidence"]), "researcher");
  // No overlap returns undefined so the caller can fall back to an explicit owner.
  assert.equal(selectOwnerRole(team, ["unknown-capability"]), undefined);
  assert.equal(selectOwnerRole(team, []), undefined);
});

test("planHandoff routes a completed builder card to its reviewer", () => {
  const team = defaultTeamSpec();
  const card: RoutableCard = { id: "task-7", kind: "task", status: "done", ownerRole: "builder" };
  const actions = planHandoff(card, team);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.reason, "review");
  assert.equal(actions[0]?.card.kind, "review");
  assert.equal(actions[0]?.card.ownerRole, "reviewer");
  assert.deepEqual(actions[0]?.card.dependsOn, ["task-7"]);
  // The onward policy is carried but acceptance is cleared so completing the review never re-reviews.
  assert.equal(actions[0]?.card.handoffPolicy?.acceptanceRequired, false);
});

test("planHandoff escalates a human-gated owner to a decision", () => {
  const team = defaultTeamSpec();
  const card: RoutableCard = { id: "task-ops", kind: "handoff", status: "done", ownerRole: "ops" };
  const actions = planHandoff(card, team);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.reason, "human-escalation");
  assert.equal(actions[0]?.card.kind, "decision");
  assert.equal(actions[0]?.card.status, "waiting_human");
});

test("planHandoff continues the chain to nextRole after a review completes", () => {
  const team = defaultTeamSpec();
  // A completed review whose carried policy names a nextRole hands off onward.
  const reviewed: RoutableCard = {
    id: "review-1",
    kind: "review",
    status: "done",
    ownerRole: "reviewer",
    handoffPolicy: { mode: "one-of-us", nextRole: "doc-writer", escalation: "coordinator", acceptanceRequired: false }
  };
  const actions = planHandoff(reviewed, team);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.reason, "next-role");
  assert.equal(actions[0]?.card.kind, "handoff");
  assert.equal(actions[0]?.card.ownerRole, "doc-writer");
  assert.equal(actions[0]?.card.targetRole, "doc-writer");
});

test("planHandoff routes review changes back to the source owner", () => {
  const team = defaultTeamSpec();
  const reviewed: RoutableCard = {
    id: "review-1",
    kind: "review",
    status: "done",
    ownerRole: "reviewer",
    sourceId: "task-7",
    sourceOwnerRole: "builder",
    result: "changes_requested",
    handoffPolicy: { mode: "one-of-us", nextRole: "doc-writer", escalation: "coordinator", acceptanceRequired: false }
  };
  const actions = planHandoff(reviewed, team);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.reason, "next-role");
  assert.equal(actions[0]?.card.kind, "handoff");
  assert.equal(actions[0]?.card.ownerRole, "builder");
  assert.equal(actions[0]?.card.sourceId, "review-1");
});

test("planHandoff is inert for non-done cards and for resolved decisions", () => {
  const team = defaultTeamSpec();
  assert.deepEqual(planHandoff({ id: "a", kind: "task", status: "in_progress", ownerRole: "builder" }, team), []);
  assert.deepEqual(planHandoff({ id: "d", kind: "decision", status: "done", ownerRole: "ops" }, team), []);
  assert.equal(roleHandoffPolicy(team, "builder")?.reviewerRole, "reviewer");
  assert.equal(roleHandoffPolicy(team, "nope"), undefined);
});
