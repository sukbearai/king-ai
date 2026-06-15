import assert from "node:assert/strict";
import { test } from "node:test";
import { runCardCommand } from "../src/gui-cli-card.js";
import { runTaskCommand } from "../src/gui-cli-task.js";
import type { GuiCliCapsule } from "../src/gui-cli-capsule.js";
import type { GuiCliCard } from "../src/gui-cli-card.js";
import type { GuiCliInitiative } from "../src/gui-cli-initiative.js";
import type { GuiCliTask } from "../src/gui-cli-task.js";
import { runCapsuleCommand } from "../src/gui-cli-capsule.js";
import { runInitiativeCommand, type RunInitiativeCommandDeps } from "../src/gui-cli-initiative.js";
import type { GuiCliContextEntry } from "../src/gui-cli-context.js";
import type { GuiCliDoc } from "../src/gui-cli-doc.js";
import { runLoopCommand } from "../src/gui-cli-loop.js";
import { runMergeCommand } from "../src/gui-cli-merge.js";
import { runPlanCommand } from "../src/gui-cli-plan.js";
import { runRouteCommand } from "../src/gui-cli-route.js";
import { runClaimCommand } from "../src/gui-cli-claim.js";
import { runSafetyCommand } from "../src/gui-cli-safety.js";
import { runSendCommand } from "../src/gui-cli-messaging.js";
import { runDocCommand } from "../src/gui-cli-doc.js";
import { runContextCommand } from "../src/gui-cli-context.js";
import { runReactCommand } from "../src/gui-cli-react.js";
import { runHypothesisCommand, type GuiCliHypothesis } from "../src/gui-cli-hypothesis.js";
import { runObserveCommand } from "../src/gui-cli-observe.js";
import { runAgentsCommand } from "../src/gui-cli-agents.js";
import { createGuiKanbanDraft } from "../src/workflow-state.js";

test("runCardCommand creates and claims kanban cards through workflow helpers", () => {
  const state = { cards: [] as GuiCliCard[] };
  const created = runCardCommand(state, ["create", "Ship", "--paths", "src/"], {
    defaultAgentId: "king-ai-ceo",
    createCard: (nextState, title, allowedPaths) => {
      const card = createGuiKanbanDraft({ title, allowedPaths });
      nextState.cards.push(card);
      return card;
    },
    pathConflict: () => undefined,
    parseAllowedPaths: (args) => {
      const idx = args.indexOf("--paths");
      return idx >= 0 ? [args[idx + 1]].filter(Boolean) : [];
    },
    stripOptions: (args, flags) => args.filter((arg, index) => !flags.includes(arg) && !flags.includes(args[index - 1])),
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    }
  });
  assert.match(created, /^card created card-/);
  const cardId = state.cards[0]?.id;
  const claimed = runCardCommand(state, ["claim", cardId, "--owner", "dev"], {
    defaultAgentId: "king-ai-ceo",
    createCard: () => state.cards[0],
    pathConflict: () => undefined,
    parseAllowedPaths: () => [],
    stripOptions: (args) => args,
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    }
  });
  assert.match(claimed, /^card claimed/);
  assert.equal(state.cards[0]?.column, "doing");
  assert.equal(state.cards[0]?.claimedBy, "dev");
});

test("runTaskCommand creates tasks via createGuiTaskDraft", () => {
  const state = { tasks: [] as GuiCliTask[] };
  const result = runTaskCommand(state, ["create", "Plan", "--assign", "dev"], { id: "dev" }, {
    lookupTask: () => ({ error: "missing" }),
    formatTaskLine: (_state, task) => task.id,
    taskScopeConflicts: () => [],
    taskScopeFromArgs: () => undefined,
    parseCsvOption: () => undefined,
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    stripOptions: (args, flags) => args.filter((arg, index) => !flags.includes(arg) && !flags.includes(args[index - 1])),
    normalizePriority: () => 5,
    isTaskStatus: (value): value is "pending" => value === "pending",
    applyTaskReviewPayload: () => {},
    pushLoopEvent: () => {},
    ensureConversation: () => ({ id: "king-ai-convo" }),
    workerAgentForConversation: () => ({ id: "dev" }),
    defaultWorkerAgentFor: () => ({ id: "dev" }),
    pushTaskTransition: () => {},
    queueTaskChangesRequestedMessage: () => {},
    advanceTaskDone: () => "done"
  });
  assert.match(result, /^Task task-/);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0]?.status, "assigned");
  assert.equal(state.tasks[0]?.assignee, "dev");
});

test("runLoopCommand records tick events", () => {
  const state = { loopRunId: undefined as string | undefined, currentLoop: 0, loopEvents: [] as Array<{ type: string; loop: number; runId?: string }> };
  const result = runLoopCommand(state, ["tick", "--run", "run-test"], {
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    parseCsvOption: () => undefined,
    readNumberOption: () => undefined,
    parseEventPayload: () => ({}),
    normalizePositiveInt: (_value, fallback) => fallback,
    isLoopEventType: () => true,
    pushLoopEvent: (nextState, event) => {
      const row = { type: String(event.type), loop: nextState.currentLoop, runId: event.runId as string | undefined };
      nextState.loopEvents.push(row);
      return row;
    },
    buildEventLoopSnapshot: () => ({ runId: "run-test", loop: 1, classification: "productive", reasons: [], recentEvents: [] }),
    formatLoopEventLine: (event) => event.type
  });
  assert.match(result, /^loop tick 1 run=run-test/);
  assert.equal(state.loopEvents.length, 1);
});

type InitiativeTestState = {
  initiatives: GuiCliInitiative[];
  tasks: GuiCliTask[];
  capsules: GuiCliCapsule[];
  docs: GuiCliDoc[];
  context: GuiCliContextEntry[];
};

function initiativeDeps(
  state: InitiativeTestState,
  overrides: Partial<RunInitiativeCommandDeps<InitiativeTestState, GuiCliInitiative>> = {}
): RunInitiativeCommandDeps<InitiativeTestState, GuiCliInitiative> {
  return {
    defaultAgentId: "king-ai-ceo",
    actorId: "dev",
    findInitiative: (_state, id) => state.initiatives.find((row) => row.id === id),
    formatInitiativeLine: (_state, initiative) => initiative.id,
    readOption: (args: string[], flag: string) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    readBooleanOption: (args: string[], flag: string) => {
      const idx = args.indexOf(flag);
      if (idx < 0) return undefined;
      const raw = args[idx + 1];
      if (raw === undefined) return true;
      return raw === "true";
    },
    stripOptions: (args: string[], flags: string[]) =>
      args.filter((arg, index) => !flags.includes(arg) && !flags.includes(args[index - 1])),
    parseCsvOption: () => undefined,
    normalizePriority: () => 5,
    isInitiativeStatus: (value: string): value is "active" => value === "active",
    parseExecutionPlan: (raw: string) => JSON.parse(raw),
    applyExecutionPlan: (_state, plan, options) =>
      `applied ${plan.optionId} initiative=${options.initiativeId} tasks=${plan.tasks.length}`,
    ...overrides
  };
}

test("runInitiativeCommand and runCapsuleCommand create records", () => {
  const state: InitiativeTestState = {
    initiatives: [],
    tasks: [],
    capsules: [],
    docs: [],
    context: []
  };
  const initiativeResult = runInitiativeCommand(state, ["create", "Q2", "--goal", "Ship"], initiativeDeps(state));
  assert.match(initiativeResult, /^Initiative initiative-/);
  const capsuleResult = runCapsuleCommand(state, ["create", "--goal", "Refactor", "--paths", "src/"], {
    defaultAgentId: "dev",
    findCapsule: () => undefined,
    formatCapsuleLine: (capsule) => capsule.id,
    capsuleConflicts: () => [],
    parseAllowedPaths: (args) => {
      const idx = args.indexOf("--paths");
      return idx >= 0 ? [args[idx + 1]].filter(Boolean) : [];
    },
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    stripOptions: (args) => args,
    parseCsvOption: () => undefined,
    isCapsuleStatus: (value): value is "open" => value === "open",
    isCapsuleScopeType: (value): value is "code" => value === "code"
  });
  assert.match(capsuleResult, /^Capsule capsule-/);
  assert.equal(state.initiatives.length, 1);
  assert.equal(state.capsules.length, 1);
});

test("runInitiativeCommand advance reports gaps and auto-applies plans", () => {
  const state: InitiativeTestState = {
    initiatives: [{
      id: "initiative-1",
      title: "Vision",
      goal: "Ship advance CLI",
      status: "active",
      priority: 7,
      created_at: 1,
      updated_at: 1
    }],
    tasks: [],
    capsules: [],
    docs: [],
    context: []
  };
  const gap = runInitiativeCommand(state, ["advance", "initiative-1"], initiativeDeps(state));
  assert.match(gap, /no tasks linked/);
  const auto = runInitiativeCommand(state, ["advance", "initiative-1", "--auto"], initiativeDeps(state));
  assert.match(auto, /applied advance-initiative-1/);
  state.tasks.push({
    id: "task-open",
    title: "In flight",
    status: "assigned",
    priority: 5,
    initiativeId: "initiative-1"
  });
  const blocked = runInitiativeCommand(state, ["advance", "initiative-1", "--auto"], initiativeDeps(state));
  assert.match(blocked, /auto: skipped/);
});

test("runInitiativeCommand persist writes vision doc and context", () => {
  const state: InitiativeTestState = {
    initiatives: [],
    tasks: [],
    capsules: [],
    docs: [],
    context: []
  };
  const result = runInitiativeCommand(state, ["persist"], initiativeDeps(state));
  assert.match(result, /^vision plan persisted doc=/);
  assert.equal(state.docs.length, 1);
  assert.match(state.docs[0]?.body || "", /Phase 1/);
  assert.equal(state.initiatives.length, 1);
  assert.ok(state.context.some((entry) => entry.key === "vision.plan.phase" && entry.value === "1"));
});

test("runMergeCommand enqueues merge requests", () => {
  const state = {
    mergeQueue: [] as Array<{ id: string; branch: string; targetBranch: string; status: string; createdAt: number; updatedAt: number; agentId: string }>,
    capsules: [{ id: "capsule-1", status: "open", updated_at: 0, branch: "feat/x", ownerAgent: "dev" }],
    tasks: [] as Array<{ status: string; updated_at: number }>
  };
  const result = runMergeCommand(state, ["enqueue", "--capsule", "capsule-1"], {
    defaultAgentId: "king-ai-ceo",
    findMergeRequest: () => undefined,
    findCapsule: (_s, id) => state.capsules.find((row) => row.id === id),
    lookupTask: () => ({ error: "missing" }),
    formatMergeRequestLine: (request) => request.id,
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    isSafeBranchName: () => true,
    isMergeStatus: (value): value is "queued" => value === "queued"
  });
  assert.match(result, /^merge queued merge-/);
  assert.equal(state.capsules[0]?.status, "in_review");
});

test("runSafetyCommand requests approval for gated actions", () => {
  const state = { approvals: [] as Array<{ id: string; action: string; status: string; createdAt: number }> };
  const result = runSafetyCommand(state, ["request", "deploy"], {
    safetyActions: ["deploy"],
    isSafetyAction: (value) => value === "deploy",
    safetyCheck: () => ({ allowed: false }),
    parseSafetyContext: () => ({}),
    stringContextValue: () => undefined,
    findApproval: () => undefined,
    formatApprovalLine: (approval) => approval.id,
    readOption: () => undefined,
    stripOptions: (args) => args
  });
  assert.match(result, /^approval requested approval-/);
  assert.equal(state.approvals.length, 1);
});

test("runRouteCommand sets event routes for agents", () => {
  const state = {
    eventRoutes: [] as Array<{ eventType: string; agentId: string; createdAt: number }>,
    agents: [{ id: "dev", name: "Dev", events: [] as string[] }]
  };
  const result = runRouteCommand(state, ["set", "task.created", "--agent", "dev"], {
    defaultAgentId: "king-ai-ceo",
    ensureRouteAgent: () => undefined,
    formatEventRouteLine: (route) => `${route.eventType}->${route.agentId}`,
    readOption: (args, flag) => {
      const idx = args.indexOf(flag);
      return idx >= 0 ? args[idx + 1] : undefined;
    },
    parseExternalEventArgs: (eventType) => ({ type: eventType }),
    routeExternalEvent: () => [],
    pushLoopEvent: () => {},
    countPendingMessages: () => 0
  });
  assert.equal(result, "route set task.created -> dev");
  assert.equal(state.eventRoutes.length, 1);
});

test("runClaimCommand and runSendCommand create workspace records", () => {
  const claimState = { claims: [] as Array<{ id: string; name: string; owner: string; created_at: number }> };
  const claimResult = runClaimCommand(claimState, ["docs"], { id: "dev" }, {
    parseAllowedPaths: () => [],
    readOption: () => undefined,
    pathConflict: () => undefined
  });
  assert.match(claimResult, /^claim created claim-/);

  const messageState = {
    messages: [] as Array<{ id: string; conversation_id: string; author_name: string; body: string; priority?: string; readBy: string[]; created_at: number; author_kind: string }>,
    agents: [{ id: "reviewer", name: "Reviewer" }]
  };
  const sendResult = runSendCommand(messageState, ["reviewer", "please review"], { id: "dev", name: "Dev" }, {
    defaultAgentId: "king-ai-ceo",
    newAgentMessage: ({ target, fromName, body, priority, messageType }) => ({
      id: "msg-1",
      conversation_id: `dm-${target}`,
      author_name: fromName,
      author_kind: "agent",
      body,
      priority,
      message_type: messageType,
      to_agent_id: target,
      created_at: 1,
      readBy: []
    }),
    resolveEscalationTarget: () => "king-ai-ceo",
    readOption: () => undefined,
    stripOptions: (args) => args,
    isRuntimeVisibleMessage: () => true,
    sortRuntimeMessages: (messages) => messages.map((row) => ({ row })),
    messageRouteTag: () => "route"
  });
  assert.match(sendResult, /^Message msg-1 queued -> reviewer/);
  assert.equal(messageState.messages.length, 1);
});

test("runPlanCommand parses execution plans", () => {
  const state = { tasks: [] as Array<{ id: string; title: string; dependsOn?: string[] }> };
  const result = runPlanCommand(state, ["parse", '{"optionId":"A","totalEstimatedTokens":10,"tasks":[]}'], {
    defaultAgentId: "dev",
    parseExecutionPlan: () => ({ optionId: "A", totalEstimatedTokens: 10, tasks: [] }),
    readOption: () => undefined,
    createTask: (input) => ({ id: "task-1", title: input.title, dependsOn: input.dependsOn })
  });
  assert.match(result, /^plan A: 0 task\(s\)/);
});

test("runDocCommand creates and shows docs", () => {
  const state = { docs: [] as Array<{ id: string; title: string; body: string; created_at: number }> };
  const created = runDocCommand(state, ["create", "Notes", "hello"]);
  assert.match(created, /^doc created doc-/);
  assert.equal(state.docs.length, 1);
  const shown = runDocCommand(state, ["show", state.docs[0].id]);
  assert.match(shown, /^Notes\n\nhello$/);
});

test("runContextCommand sets and gets context keys", () => {
  const state = { context: [] as Array<{ key: string; value: string; updatedBy: string; updatedAt: number }> };
  const setResult = runContextCommand(state, ["set", "theme", "dark"], { id: "dev" }, {
    readOption: () => undefined,
    stripOptions: (args) => args
  });
  assert.equal(setResult, 'Set "theme" = "dark"');
  const getResult = runContextCommand(state, ["get", "theme"], { id: "dev" }, {
    readOption: () => undefined,
    stripOptions: (args) => args
  });
  assert.equal(getResult, "dark");
});

test("runReactCommand posts reactions", () => {
  const state = { reactions: [] as Array<{ messageId: string; emoji: string; authorId: string; created_at: number }> };
  const result = runReactCommand(state, ["msg-1", "👍"], { id: "dev" });
  assert.match(result, /^reaction posted msg-1 👍$/);
  assert.equal(state.reactions[0].authorId, "dev");
});

test("runHypothesisCommand creates hypotheses", () => {
  const state = { hypotheses: [] as GuiCliHypothesis[] };
  const result = runHypothesisCommand(state, ["create", "Ship faster"], { id: "dev" }, {
    readOption: () => undefined,
    stripOptions: (args) => args,
    parseCsvOption: () => undefined,
    isHypothesisStatus: (value) => value === "proposed",
    findHypothesis: () => undefined,
    formatHypothesisLine: (hypothesis) => hypothesis.title
  });
  assert.match(result, /^Hypothesis hyp-/);
  assert.equal(state.hypotheses[0].title, "Ship faster");
});

test("runObserveCommand renders loop snapshot summary", () => {
  const state = {};
  const result = runObserveCommand(state, [], {
    buildLoopSnapshot: () => ({
      classification: "idle",
      reasons: ["no state changes detected"],
      counts: { unreadMessages: 0, blockedTasks: 0, activeTasks: 0, openCapsules: 0, inReviewCapsules: 0, artifacts: 0, failedRuns: 0 }
    }),
    readOption: () => undefined
  });
  assert.match(result, /^classification=idle/);
  assert.match(result, /activeTasks=0/);
});

test("runAgentsCommand renders agent matrix", () => {
  const state = { agents: [{ id: "dev", name: "Dev", role: "Engineer" }] };
  const result = runAgentsCommand(state, [], {
    agentStateSummary: (nextState, agent) => ({
      ...agent,
      engine: "auto",
      lifecycle: "on-demand",
      status: "idle",
      model: "default",
      fastModel: "default",
      unreadMessages: 0,
      openClaims: 0,
      activeCards: 0,
      openTasks: 0,
      blockedTasks: 0
    }),
    formatAgentMatrixLine: (agent) => `${agent.id} ${agent.status}`
  });
  assert.match(result, /^Agent Matrix:/);
  assert.match(result, /dev idle/);
});
