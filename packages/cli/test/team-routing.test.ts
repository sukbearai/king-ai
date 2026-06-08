import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTeamSpec } from "../src/team-workflow.js";
import { planHandoff, roleHandoffPolicy, selectOwnerRole, type RoutableCard } from "../src/team-routing.js";
import {
  mergeWorkflowCards,
  taskDoneTransition,
  workflowAgendaLines,
  workflowCardFromCapsule,
  workflowCardFromHostRecord,
  workflowCardFromKanban,
  workflowCardFromTask,
  workflowReadiness
} from "../src/workflow-core.js";

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

test("taskDoneTransition centralizes GUI and host task review transitions", () => {
  assert.deepEqual(taskDoneTransition({ id: "task-1", kind: "task", status: "assigned", assignee: "dev" }, "dev", {
    coordinatorId: "king-ai-ceo",
    reviewerId: "reviewer",
    hasConversation: true
  }), { status: "review", assignee: "reviewer" });
  assert.deepEqual(taskDoneTransition({ id: "task-1", kind: "task", status: "review", assignee: "reviewer" }, "reviewer", {
    coordinatorId: "king-ai-ceo",
    reviewerId: "reviewer",
    hasConversation: true
  }), { status: "done", assignee: "king-ai-ceo", reviewResult: "approved", reviewedBy: "reviewer" });
  assert.deepEqual(taskDoneTransition({ id: "task-2", kind: "task", status: "assigned", assignee: "dev" }, "dev"), {
    status: "done",
    assignee: "dev"
  });
});

test("workflowReadiness centralizes dependency evidence and review gates", () => {
  assert.deepEqual(workflowCardFromTask({
    id: "task-1",
    status: "assigned",
    title: "Build",
    assignee: "dev",
    dependsOn: ["setup"],
    acceptance: ["evidence"]
  }), {
    id: "task-1",
    kind: "task",
    status: "assigned",
    title: "Build",
    assignee: "dev",
    dependsOn: ["setup"],
    acceptance: ["evidence"]
  });
  assert.deepEqual(workflowReadiness({
    id: "task-2",
    kind: "task",
    status: "assigned",
    dependsOn: ["task-1"],
    acceptance: ["evidence required"]
  }, ["task-123456"]), {
    ready: false,
    blockedBy: ["task-1"],
    missingEvidence: true,
    missingReviewVerdict: false
  });
  assert.deepEqual(workflowReadiness({
    id: "review-1",
    kind: "review",
    status: "done",
    result: "changes requested"
  }, []), {
    ready: true,
    blockedBy: [],
    missingEvidence: false,
    missingReviewVerdict: false
  });
  assert.equal(workflowReadiness({ id: "review-2", kind: "review", status: "done" }, []).missingReviewVerdict, true);
});

test("workflowCardFromKanban and workflowCardFromHostRecord normalize alternate ledgers", () => {
  assert.deepEqual(workflowCardFromKanban({
    id: "card-1",
    title: "Ship",
    column: "doing",
    assignee: "dev"
  }), {
    id: "card-1",
    kind: "task",
    status: "in_progress",
    title: "Ship",
    assignee: "dev"
  });
  assert.deepEqual(workflowCardFromHostRecord({
    id: "decision-1",
    kind: "decision",
    status: "waiting_human",
    title: "Release?",
    decisionBy: "human"
  }), {
    id: "decision-1",
    kind: "decision",
    status: "waiting_human",
    title: "Release?"
  });
  assert.deepEqual(mergeWorkflowCards(
    [{ id: "task-1", kind: "task", status: "assigned", title: "GUI" }],
    [{ id: "task-1", kind: "task", status: "review", assignee: "reviewer" }]
  ), [{
    id: "task-1",
    kind: "task",
    status: "review",
    title: "GUI",
    assignee: "reviewer"
  }]);
});

test("workflowAgendaLines builds a canonical agenda brief", () => {
  const brief = workflowAgendaLines({
    agentId: "dev",
    tasks: [{ id: "task-1", status: "assigned", title: "Build", assignee: "dev" }],
    kanban: [{ id: "card-1", title: "Board", column: "todo", assignee: "dev" }],
    calendar: [{ id: "cal-1", title: "Follow up", assignee: "dev", at: new Date(0).toISOString() }],
    doneTaskIds: [],
    taskStatusFor: (task) => task.status ?? "assigned",
    now: new Date(10_000)
  });
  assert.equal(brief.actionable, true);
  assert.match(brief.brief ?? "", /Calendar due: Follow up/);
  assert.match(brief.brief ?? "", /Board card: card-1/);
  assert.match(brief.brief ?? "", /Task: task-1/);
});

test("workflowCardFromCapsule normalizes capsule workflow state", () => {
  assert.deepEqual(workflowCardFromCapsule({
    id: "capsule-1",
    status: "in_review",
    goal: "Ship scoped change",
    owner: "dev",
    reviewer: "reviewer",
    acceptance: "tests pass",
    taskId: "task-1"
  }), {
    id: "capsule-1",
    kind: "handoff",
    status: "review",
    title: "Ship scoped change",
    ownerRole: "dev",
    reviewerRole: "reviewer",
    sourceId: "task-1",
    acceptance: ["tests pass"]
  });
  assert.equal(workflowCardFromCapsule({ id: "capsule-2", status: "open" }).status, "assigned");
  assert.equal(workflowCardFromCapsule({ id: "capsule-3", status: "accepted" }).status, "done");
  assert.equal(workflowCardFromCapsule({ id: "capsule-4", status: "merged" }).status, "done");
});
