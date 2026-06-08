import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addGuiTaskToState,
  applyGuiTaskDone,
  applyGuiTaskWritePatch,
  applyGuiKanbanClaim,
  applyGuiKanbanMove,
  applyWorkflowPatchToGuiKanban,
  applyWorkflowPatchToGuiTask,
  createGuiKanbanDraft,
  createGuiTaskDraft,
  listGuiWorkflowCards,
  mergeGuiAndHostWorkflowCards,
  updateGuiTaskFromPatch,
  workflowStatusToGuiTaskStatus
} from "../src/workflow-state.js";

test("createGuiTaskDraft assigns pending status without assignee", () => {
  const task = createGuiTaskDraft({ title: "Plan" }, 1_000);
  assert.equal(task.status, "pending");
  assert.equal(task.id.startsWith("task-"), true);
  assert.equal(task.created_at, 1_000);
});

test("applyGuiTaskDone routes builder work to reviewer when configured", () => {
  const task = createGuiTaskDraft({
    title: "Build",
    status: "assigned",
    assignee: "dev",
    reviewerRole: "reviewer"
  }, 1_000);
  const result = applyGuiTaskDone(task, {
    actorId: "dev",
    coordinatorId: "king-ai-ceo",
    reviewerId: "reviewer",
    hasConversation: true,
    resultText: "done"
  });
  assert.equal(result.outcome, "review");
  assert.equal(task.status, "review");
  assert.equal(task.assignee, "reviewer");
});

test("applyWorkflowPatchToGuiTask maps workflow statuses onto gui tasks", () => {
  const task = createGuiTaskDraft({ title: "Ship", status: "assigned", assignee: "dev" });
  applyWorkflowPatchToGuiTask(task, { status: "waiting_human", assignee: "ops" });
  assert.equal(task.status, "review");
  assert.equal(task.assignee, "ops");
  assert.equal(workflowStatusToGuiTaskStatus("open"), "pending");
});

test("createGuiKanbanDraft and kanban patch helpers keep column semantics", () => {
  const card = createGuiKanbanDraft({ title: "Board item", allowedPaths: ["src/"] }, 2_000);
  assert.equal(card.column, "todo");
  assert.equal(card.id.startsWith("card-"), true);
  applyGuiKanbanClaim(card, "dev");
  assert.equal(card.column, "doing");
  assert.equal(card.claimedBy, "dev");
  applyGuiKanbanMove(card, "done");
  assert.equal(card.column, "done");
  assert.equal(card.claimedBy, undefined);
  const reset = createGuiKanbanDraft({ title: "Patch me" });
  applyWorkflowPatchToGuiKanban(reset, { status: "in_progress", assignee: "ops" });
  assert.equal(reset.column, "doing");
  assert.equal(reset.assignee, "ops");
});

test("listGuiWorkflowCards and mergeGuiAndHostWorkflowCards unify ledgers", () => {
  const gui = listGuiWorkflowCards({
    tasks: [{ id: "task-1", status: "assigned", title: "GUI task", assignee: "dev" }],
    kanban: [{ id: "card-1", title: "Board", column: "doing", assignee: "dev" }]
  });
  assert.equal(gui.length, 2);
  const merged = mergeGuiAndHostWorkflowCards(gui, [{
    id: "task-1",
    kind: "decision",
    status: "waiting_human",
    title: "Host override"
  }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((card) => card.id === "task-1")?.kind, "decision");
  assert.equal(merged.find((card) => card.id === "card-1")?.status, "in_progress");
});

test("addGuiTaskToState and updateGuiTaskFromPatch route writes through WorkflowCard patch", () => {
  const state = { tasks: [] as ReturnType<typeof createGuiTaskDraft>[] };
  const task = addGuiTaskToState(state, { title: "Ship", assignee: "dev" });
  assert.equal(state.tasks.length, 1);
  const result = updateGuiTaskFromPatch(task, { status: "waiting_human", result: "ready for review" });
  assert.equal(result.statusChanged, true);
  assert.equal(task.status, "review");
  assert.equal(task.result, "ready for review");
  applyGuiTaskWritePatch(task, { title: "Ship v2" });
  assert.equal(task.title, "Ship v2");
});
