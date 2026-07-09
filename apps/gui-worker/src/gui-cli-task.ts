import {
  applyGuiTaskChangesRequested,
  addGuiTaskToState,
  createGuiTaskDraft,
  updateGuiTaskFromPatch,
} from "./workflow-state.js";

export type GuiCliTaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed" | "blocked";

export type GuiCliTask = {
  id: string;
  title: string;
  description?: string;
  status: GuiCliTaskStatus;
  assignee?: string;
  ownerRole?: string;
  reviewerRole?: string;
  priority: number;
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
  reviewResult?: "approved" | "changes_requested";
  revisionReason?: string;
  artifactIds?: string[];
  reviewedByAgentId?: string;
  reviewedAt?: number;
  updated_at?: number;
};

export type GuiCliTaskActor = { id: string };

export type TaskLookupResult<T extends GuiCliTask> = {
  task?: T;
  error: string;
};

export type RunTaskCommandDeps<S extends { tasks: GuiCliTask[] }, T extends GuiCliTask, A extends GuiCliTaskActor> = {
  lookupTask: (state: S, id: string | undefined) => TaskLookupResult<T>;
  formatTaskLine: (state: S, task: T) => string;
  taskScopeConflicts: (state: S, task: T, assignee?: string) => string[];
  taskScopeFromArgs: (args: string[]) => { paths?: string[]; patterns?: string[] } | undefined;
  parseCsvOption: (args: string[], flag: string) => string[] | undefined;
  readOption: (args: string[], flag: string) => string | undefined;
  stripOptions: (args: string[], flags: string[]) => string[];
  normalizePriority: (value: string | undefined) => number;
  isTaskStatus: (value: string) => value is GuiCliTaskStatus;
  applyTaskReviewPayload: (
    task: T,
    payload: {
      reviewResult?: string;
      revisionReason?: string;
      artifactIds?: string[];
    },
    reviewer: A,
  ) => void;
  pushLoopEvent: (state: S, event: Record<string, unknown>) => void;
  ensureConversation: (state: S, id: string) => { id: string };
  workerAgentForConversation: (state: S, conversation: { id: string }) => { id: string } | undefined;
  defaultWorkerAgentFor: (state: S) => { id: string };
  pushTaskTransition: (state: S, task: T, previousStatus: GuiCliTaskStatus) => void;
  queueTaskChangesRequestedMessage: (state: S, task: T, assignee: string) => void;
  advanceTaskDone: (state: S, task: T, actor: A, resultText?: string) => string;
};

export function runTaskCommand<S extends { tasks: GuiCliTask[] }, T extends GuiCliTask, A extends GuiCliTaskActor>(
  state: S,
  args: string[],
  actor: A,
  deps: RunTaskCommandDeps<S, T, A>,
): string {
  const cmd = args[0] || "list";
  if (cmd === "list") {
    const status = deps.readOption(args, "--status") as GuiCliTaskStatus | undefined;
    const assignee = deps.readOption(args, "--assignee") || deps.readOption(args, "--assign");
    const initiative = deps.readOption(args, "--initiative");
    const capsule = deps.readOption(args, "--capsule");
    const tasks = state.tasks.filter(
      (task) =>
        (!status || task.status === status) &&
        (!assignee || task.assignee === assignee) &&
        (!initiative || task.initiativeId === initiative) &&
        (!capsule || task.capsuleId === capsule),
    ) as T[];
    if (tasks.length === 0) return "No tasks found.";
    return tasks.map((task) => deps.formatTaskLine(state, task)).join("\n") + `\n\n${tasks.length} task(s)`;
  }
  if (cmd === "get") {
    const lookup = deps.lookupTask(state, args[1]);
    if (!lookup.task) return lookup.error;
    return JSON.stringify(lookup.task, null, 2);
  }
  if (cmd === "create") {
    const title = deps
      .stripOptions(args.slice(1), [
        "--assign",
        "--assignee",
        "--priority",
        "--parent",
        "--after",
        "--path",
        "--pattern",
        "--desc",
        "--initiative",
        "--capsule",
        "--subsystem",
        "--profile",
        "--owner-role",
        "--reviewer-role",
        "--acceptance",
        "--blocked-by",
      ])
      .join(" ")
      .trim();
    if (!title) {
      return "usage: king-ai task create <title> [--assign agent-id] [--priority 1-10] [--after id1,id2] [--path a,b] [--pattern a,b] [--desc text]";
    }
    const task = addGuiTaskToState(state, {
      title,
      description: deps.readOption(args, "--desc"),
      status: deps.readOption(args, "--assign") || deps.readOption(args, "--assignee") ? "assigned" : "pending",
      assignee: deps.readOption(args, "--assign") || deps.readOption(args, "--assignee"),
      ownerRole: deps.readOption(args, "--owner-role"),
      reviewerRole: deps.readOption(args, "--reviewer-role"),
      priority: deps.normalizePriority(deps.readOption(args, "--priority")),
      parentId: deps.readOption(args, "--parent"),
      dependsOn: deps.parseCsvOption(args, "--after"),
      blockedBy: deps.parseCsvOption(args, "--blocked-by"),
      acceptance: deps.parseCsvOption(args, "--acceptance"),
      initiativeId: deps.readOption(args, "--initiative"),
      capsuleId: deps.readOption(args, "--capsule"),
      subsystem: deps.readOption(args, "--subsystem"),
      scope: deps.taskScopeFromArgs(args),
      executionProfile: deps.readOption(args, "--profile"),
    }) as T;
    const conflicts = deps.taskScopeConflicts(state, task, task.assignee);
    return (
      `Task ${task.id} created: "${task.title}" [${task.status}]` +
      (conflicts.length ? `\nWarnings: ${conflicts.join("; ")}` : "")
    );
  }
  if (cmd === "update") {
    const lookup = deps.lookupTask(state, args[1]);
    if (!lookup.task) return lookup.error;
    const task = lookup.task;
    const status = deps.readOption(args, "--status");
    if (status && !deps.isTaskStatus(status)) return `invalid task status: ${status}`;
    const scope = deps.taskScopeFromArgs(args);
    const reviewResult = deps.readOption(args, "--review");
    const writeResult = updateGuiTaskFromPatch(task, {
      status: status && deps.isTaskStatus(status) ? status : undefined,
      assignee: deps.readOption(args, "--assign") || deps.readOption(args, "--assignee") || undefined,
      ownerRole: deps.readOption(args, "--owner-role"),
      reviewerRole: deps.readOption(args, "--reviewer-role"),
      blockedBy: deps.parseCsvOption(args, "--blocked-by"),
      acceptance: deps.parseCsvOption(args, "--acceptance"),
      result: deps.readOption(args, "--result"),
      reviewResult: reviewResult === "approved" || reviewResult === "changes_requested" ? reviewResult : undefined,
      revisionReason: deps.readOption(args, "--reason"),
      artifactIds: deps.parseCsvOption(args, "--artifact") ?? deps.parseCsvOption(args, "--artifacts"),
      initiativeId: deps.readOption(args, "--initiative"),
      capsuleId: deps.readOption(args, "--capsule"),
      subsystem: deps.readOption(args, "--subsystem"),
      executionProfile: deps.readOption(args, "--profile"),
      scope: scope ? { ...(task.scope ?? {}), ...scope } : undefined,
      reviewedByAgentId: reviewResult === "approved" || reviewResult === "changes_requested" ? actor.id : undefined,
      reviewedAt: reviewResult === "approved" || reviewResult === "changes_requested" ? Date.now() : undefined,
    });
    if (writeResult.statusChanged) {
      deps.pushLoopEvent(state, {
        type: "task.transition",
        agent: task.assignee,
        taskId: task.id,
        from: writeResult.previousStatus,
        to: task.status,
      });
    }
    return `Task ${task.id} updated [${task.status}]`;
  }
  if (cmd === "done") {
    const lookup = deps.lookupTask(state, args[1]);
    if (!lookup.task) return lookup.error;
    const task = lookup.task;
    const review = deps.readOption(args, "--review");
    const reason = deps.readOption(args, "--reason");
    const artifactIds = deps.parseCsvOption(args, "--artifact") ?? deps.parseCsvOption(args, "--artifacts");
    const resultText = deps
      .stripOptions(args.slice(2), ["--review", "--reason", "--artifact", "--artifacts"])
      .join(" ")
      .trim();
    if (review && review !== "approved" && review !== "changes_requested") {
      return "invalid review result: use approved or changes_requested";
    }
    if (review === "changes_requested") {
      const conversation = task.conversationId ? deps.ensureConversation(state, task.conversationId) : undefined;
      const worker = conversation
        ? deps.workerAgentForConversation(state, conversation)
        : deps.defaultWorkerAgentFor(state);
      const workerId = worker?.id ?? deps.defaultWorkerAgentFor(state).id;
      const previousStatus = applyGuiTaskChangesRequested(task, {
        actorId: actor.id,
        workerId,
        reason: reason || resultText || "Reviewer requested revisions.",
        artifactIds,
      });
      if (previousStatus !== task.status) deps.pushTaskTransition(state, task, previousStatus);
      deps.queueTaskChangesRequestedMessage(state, task, task.assignee ?? workerId);
      return `Task ${task.id} returned to ${task.assignee}: ${task.revisionReason}`;
    }
    if (artifactIds?.length) task.artifactIds = artifactIds;
    if (review === "approved") task.reviewResult = "approved";
    return deps.advanceTaskDone(state, task, actor, resultText);
  }
  return "usage: king-ai task create|list|get|update|done";
}
