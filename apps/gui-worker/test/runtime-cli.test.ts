import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchRuntimeCli } from "../src/runtime-cli-dispatch.js";
import { runtimeCliHelp } from "../src/runtime-cli-help.js";

test("runtimeCliHelp lists core collaboration commands", () => {
  const help = runtimeCliHelp();
  assert.match(help, /king-ai task create/);
  assert.match(help, /king-ai card list/);
  assert.match(help, /king-ai reply/);
});

test("dispatchRuntimeCli routes help without mutating state", async () => {
  type TestState = {
    messages: Array<Record<string, unknown>>;
    agents: Array<{ id: string; name: string; engine?: string }>;
    composing: Array<{ conversationId: string; agentName: string; claimed_at: number; expires_at: number }>;
    claims: Array<{ conversationId: string; name: string; owner: string }>;
    statusLog: Array<{ status?: string }>;
    availableEngines: string[];
  };
  const state: TestState = { messages: [], agents: [], composing: [], claims: [], statusLog: [], availableEngines: [] };
  const actor = { id: "dev", name: "Dev", engine: "codex" };
  const outcome = await dispatchRuntimeCli({
    argv: ["help"],
    state,
    actor,
    authorEngine: "codex",
    runContract: undefined,
    payload: {}
  }, {
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
  });
  assert.equal(outcome.kind, "success");
  if (outcome.kind === "success") assert.match(outcome.result, /king-ai inbox/);
});
