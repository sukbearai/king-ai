import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchRuntimeCli } from "../src/runtime-cli-dispatch.js";
import type { RuntimeCliDeps } from "../src/runtime-cli-dispatch.js";
import { runtimeCliHelp } from "../src/runtime-cli-help.js";

type TestState = {
  messages: Array<Record<string, unknown>>;
  agents: Array<{ id: string; name: string; engine?: string }>;
  composing: Array<{ conversationId: string; agentName: string; claimed_at: number; expires_at: number }>;
  claims: Array<{ conversationId: string; name: string; owner: string }>;
  statusLog: Array<{ status?: string }>;
  availableEngines: string[];
};

function freshState(): TestState {
  return { messages: [], agents: [], composing: [], claims: [], statusLog: [], availableEngines: [] };
}

type Actor = { id: string; name: string; engine?: string };
type Deps = RuntimeCliDeps<TestState, Actor>;

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const base: Deps = {
    defaultAgentId: "king-ai-ceo",
    findConversation: () => undefined,
    validateRunContractAction: () => undefined,
    unreadMessagesFor: () => [],
    isRuntimeVisibleMessage: () => true,
    pendingBelongsToAgent: () => false,
    recordRunAction: () => {},
    agentStateSummary: () => ({}),
    formatRosterAgent: () => "",
    buildRuntimePreamble: () => "",
    readOption: () => undefined,
    displayNameForHuman: () => "Human",
    isTaskMutationCommand: () => false,
    isCliUsageOrError: () => false,
    stateCommand: async () => "",
    agentsCommand: () => "",
    observeCommand: () => "",
    loopCommand: () => "",
    cardCommand: () => "",
    taskCommand: () => "",
    initiativeCommand: () => "",
    capsuleCommand: () => "",
    mergeCommand: () => "",
    evalCommand: () => "",
    feedbackCommand: () => "",
    reviewCommand: () => "",
    routeCommand: () => "",
    calendarCommand: () => "",
    claimCommand: () => "",
    unclaimCommand: () => "",
    dmCommand: () => "",
    reactCommand: () => "",
    docCommand: () => "",
    artifactCommand: () => "",
    contextCommand: () => "",
    hypothesisCommand: () => "",
    planCommand: () => "",
    safetyCommand: () => "",
    sendCommand: () => "",
    recvCommand: () => "",
    recallCommand: () => "",
    escalateCommand: () => "",
    agendaJson: async () => ({}),
    getStateField: {
      messages: (s) => s.messages,
      pushMessage: (s, message) => { s.messages.push(message); },
      agents: (s) => s.agents,
      composing: (s) => s.composing,
      setComposing: (s, composing) => { s.composing = composing; },
      claims: (s) => s.claims,
      statusLog: (s) => s.statusLog,
      availableEngines: (s) => s.availableEngines
    },
    actorField: {
      id: (a) => a.id,
      name: (a) => a.name,
      engine: (a) => a.engine,
      json: (a) => a
    }
  };
  return { ...base, ...overrides };
}

test("runtimeCliHelp lists core collaboration commands", () => {
  const help = runtimeCliHelp();
  assert.match(help, /king-ai task create/);
  assert.match(help, /king-ai card list/);
  assert.match(help, /king-ai reply/);
});

test("dispatchRuntimeCli routes help without mutating state", async () => {
  const state = freshState();
  const actor = { id: "dev", name: "Dev", engine: "codex" };
  const outcome = await dispatchRuntimeCli({
    argv: ["help"],
    state,
    actor,
    authorEngine: "codex",
    runContract: undefined,
    payload: {}
  }, makeDeps());
  assert.equal(outcome.kind, "success");
  if (outcome.kind === "success") assert.match(outcome.result, /king-ai inbox/);
});

test("dispatchRuntimeCli only contract-checks id-targeted task mutations, not flags or reads", async () => {
  const actor = { id: "dev", name: "Dev", engine: "codex" };
  // Mirrors gui-runtime's isTaskMutationCommand: only done/update/create mutate.
  const isTaskMutationCommand = (args: string[]) => args[0] === "done" || args[0] === "update" || args[0] === "create";
  const seenTaskIds: Array<string | undefined> = [];
  const run = (argv: string[]) =>
    dispatchRuntimeCli({
      argv,
      state: freshState(),
      actor,
      authorEngine: "codex",
      // A live wake contract pinned to one task; the bug let any argv[2] (incl. flags) trip it.
      runContract: { agentId: "dev", taskId: "task-pinned" },
      payload: { runId: "run-1" }
    }, makeDeps({
      isTaskMutationCommand,
      taskCommand: () => "ok",
      validateRunContractAction: (_state, _contract, _actor, action) => {
        seenTaskIds.push(action.taskId);
        return undefined;
      }
    }));

  await run(["task", "list", "--json"]); // read subcommand: no taskId
  await run(["task", "done", "--help"]);  // usage flag must not be read as a taskId
  await run(["task", "get", "task-123"]); // read subcommand: not contract-gated
  await run(["task", "done", "task-123"]); // real id-targeted mutation: validated
  await run(["task", "create", "Write the spec"]); // create makes a new id, not validated

  assert.deepEqual(seenTaskIds, [undefined, undefined, undefined, "task-123", undefined]);
});
