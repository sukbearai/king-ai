import assert from "node:assert/strict";
import { test } from "node:test";
import {
  abortWakeStream,
  buildStandingPrompt,
  buildAgendaDelta,
  buildChatDelta,
  appendRuntimePreamble,
  buildRuntimePreambleSection,
  agentSessionFile,
  formatTriageNote,
  formatSteerPrompt,
  isContextOverflow,
  isPoisonedTranscript,
  mustResetSession,
  parseWakeEventInfo,
  selectSteerMessage,
  Semaphore,
  sessionResetReason,
  shouldHandleWakeEvent,
  shouldStopEngineOnBeginStop,
  replaceWakeStreamController,
  sanitizeNestedEngineEnv,
  swallowTurnRejection,
  visibleEngineError
} from "../src/runner.js";

test("agentSessionFile scopes session ids by engine", () => {
  assert.match(agentSessionFile("king-agent", "claude"), /king-agent\.claude\.session$/);
  assert.match(agentSessionFile("king-agent", "codex"), /king-agent\.codex\.session$/);
});

test("parseWakeEventInfo extracts conversation and delivery latency", () => {
  assert.deepEqual(parseWakeEventInfo(undefined, 2000), {
    conversationId: null,
    agentId: null,
    sentAt: null,
    deliveryLatencyMs: null
  });
  assert.deepEqual(parseWakeEventInfo(JSON.stringify({ conversationId: "demo-convo", agentId: "dev", at: 1500 }), 2000), {
    conversationId: "demo-convo",
    agentId: "dev",
    sentAt: 1500,
    deliveryLatencyMs: 500
  });
  assert.deepEqual(parseWakeEventInfo("not json", 2000), {
    conversationId: null,
    agentId: null,
    sentAt: null,
    deliveryLatencyMs: null
  });
  assert.equal(parseWakeEventInfo(JSON.stringify({ at: 2500 }), 2000).deliveryLatencyMs, 0);
});

test("shouldHandleWakeEvent keeps targeted wake events on the owning agent", () => {
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ agentId: "dev" })), "dev"), true);
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ agentId: "reviewer" })), "dev"), false);
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ conversationId: "all" })), "dev"), true);
});

test("Semaphore queues callers beyond the concurrency limit", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  let secondAcquired = false;
  const second = sem.acquire().then(() => {
    secondAcquired = true;
  });

  await Promise.resolve();
  assert.equal(secondAcquired, false);
  assert.equal(sem.queueDepth, 1);

  sem.release();
  await second;
  assert.equal(secondAcquired, true);
  assert.equal(sem.queueDepth, 0);

  sem.release();
});

test("mustResetSession follows King session reset rules", () => {
  assert.equal(isContextOverflow("context_length_exceeded: prompt is too long"), true);
  assert.equal(isPoisonedTranscript("request body is not valid json: unpaired surrogate"), true);

  assert.equal(mustResetSession("maximum context reached", false), true);
  assert.equal(mustResetSession("lone surrogate in string", false), true);
  assert.equal(mustResetSession("could not resume missing session", true), true);
  assert.equal(mustResetSession("could not resume missing session", false), false);
  assert.equal(mustResetSession("not logged in", true), false);

  assert.equal(sessionResetReason("too many tokens"), "engine hit its context-window limit");
  assert.equal(sessionResetReason("surrogate in string"), "transcript poisoned by a malformed character");
  assert.equal(sessionResetReason("session gone"), "engine session problem");
});

test("selectSteerMessage picks direct pings and dedupes by latest id", () => {
  const rows = [
    {
      id: "m1",
      conversation_id: "group",
      conversation_kind: "group",
      author_name: "Peer",
      author_kind: "agent",
      body: "status update"
    },
    {
      id: "m2",
      conversation_id: "group",
      conversation_kind: "group",
      author_name: "Human",
      author_kind: "human",
      body: "can you check this?"
    },
    {
      id: "m3",
      conversation_id: "dm",
      conversation_kind: "direct",
      author_name: "Demo Human",
      author_kind: "human",
      body: "quick ping"
    }
  ];

  assert.equal(selectSteerMessage(rows, "group", "demo-agent", null)?.id, "m2");
  assert.equal(selectSteerMessage(rows, "group", "demo-agent", "m2"), null);
  assert.equal(selectSteerMessage(rows, "dm", "demo-agent", null)?.id, "m3");
  assert.equal(selectSteerMessage([{ ...rows[0], body: "@demo-agent ping" }], "group", "demo-agent", null)?.id, "m1");
  assert.equal(selectSteerMessage([rows[0]], "group", "demo-agent", null), null);
  assert.equal(selectSteerMessage([
    { ...rows[0], id: "m4" },
    { ...rows[0], id: "m5", message_type: "blocker", to_agent_id: "demo-agent", body: "blocked on deploy" }
  ], "group", "demo-agent", null)?.id, "m5");
  assert.equal(selectSteerMessage([
    { ...rows[0], id: "m6", priority: "steer", body: "@demo-agent urgent" },
    { ...rows[0], id: "m7", author_kind: "human", body: "later but less urgent" }
  ], "group", "demo-agent", "m6")?.id, "m7");
});

test("formatSteerPrompt asks for a brief reply then resume", () => {
  const prompt = formatSteerPrompt(
    {
      id: "m1",
      conversation_id: "demo-convo",
      author_name: "Demo Human",
      body: "hello\nthere"
    },
    "demo-convo"
  );
  assert.match(prompt, /Answer it briefly/);
  assert.match(prompt, /resume your current task/);
  assert.match(prompt, /runtime message arrived/);
  assert.match(prompt, /king reply demo-convo/);
  assert.match(prompt, /hello there/);
});

test("buildStandingPrompt documents King command habits", () => {
  const prompt = buildStandingPrompt(["/Users/fayon/workspace/github"], "/tmp/agents/demo-agent");
  assert.match(prompt, /Use the king CLI on PATH/);
  assert.match(prompt, /Agent workspace root: \/tmp\/agents\/demo-agent/);
  assert.match(prompt, /\/Users\/fayon\/workspace\/github/);
  assert.match(prompt, /king glance <conversationId>/);
  assert.match(prompt, /king card claim <cardId>/);
  assert.match(prompt, /context get\|set\|list/);
  assert.match(prompt, /artifact put\|list\|get/);
  assert.match(prompt, /hypothesis create\|list\|update/);
  assert.match(prompt, /task list\|create\|update\|done/);
  assert.match(prompt, /king reply <conversationId> --file notes\/reply\.md/);
  assert.match(prompt, /Shared skills:/);
  assert.match(prompt, /KING_SHARED_SKILLS/);
  assert.match(prompt, /activation snapshot/);
  assert.match(prompt, /KING_SKILL_SNAPSHOTS_DIR/);
  assert.match(prompt, /Host home entries:/);
  assert.match(prompt, /KING_HOST_HOME_ENTRIES/);
  assert.match(prompt, /raised hands ordered by who started first/);
  assert.match(prompt, /doc create, calendar create, group-level mutations/);
  assert.match(prompt, /Skype shortcode text/);
  assert.match(prompt, /calendar create '<chase>'/);
});

test("buildChatDelta carries fetched inbox, roster, and response mode guidance", () => {
  const delta = buildChatDelta("m1: hello", "memory item", "demo-agent\tDemo Agent", {
    actionable: true,
    responseMode: "one-of-us",
    promptNote: "reply once",
    reason: "direct ask",
    source: "local"
  });
  assert.match(delta, /ALREADY FETCHED/);
  assert.match(delta, /no need to re-run king inbox or messages/);
  assert.match(delta, /Response mode: one-of-us/);
  assert.match(formatTriageNote({ actionable: true, routeHint: "steer", priority: "urgent" }), /Priority: urgent/);
  assert.match(formatTriageNote({ actionable: true, routeHint: "steer", priority: "urgent" }), /Route hint: steer/);
  assert.match(delta, /coordinate with glance\/claims/);
  assert.match(delta, /trust over memory/);
  assert.match(delta, /demo-agent\tDemo Agent/);
});

test("formatTriageNote explains all King response modes", () => {
  assert.match(formatTriageNote({ actionable: true, responseMode: "me" }), /specifically for you/);
  assert.match(formatTriageNote({ actionable: true, responseMode: "each" }), /may contribute their own distinct reply/);
  assert.match(formatTriageNote({ actionable: true, responseMode: "one-of-us" }), /only one teammate handles/);
});

test("buildAgendaDelta keeps agenda anti-revival and roster guidance", () => {
  const delta = buildAgendaDelta("card-1", "memory item", "demo-agent\tDemo Agent");
  assert.match(delta, /already concluded/);
  assert.match(delta, /reviving a finished thread is noise/);
  assert.match(delta, /send at most one useful follow-up/);
  assert.match(delta, /trust over memory/);
});

test("runtime preamble helpers prepend current system context", () => {
  assert.equal(buildRuntimePreambleSection(""), "");
  const section = buildRuntimePreambleSection("## Runtime Context\nTask: ship");
  assert.match(section, /Runtime preamble \(current system context\):/);
  assert.match(section, /Task: ship/);
  const combined = appendRuntimePreamble("Unread messages", "Loop #3");
  assert.match(combined, /^Runtime preamble/);
  assert.match(combined, /Loop #3\n\nUnread messages/);
  assert.equal(appendRuntimePreamble("Unread messages", ""), "Unread messages");
});

test("beginStop phase preserves in-flight engine sessions", () => {
  assert.equal(shouldStopEngineOnBeginStop(), false);
});

test("wake stream controller helpers abort stale streams", () => {
  const first = new AbortController();
  const second = replaceWakeStreamController(first);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);

  abortWakeStream(second);
  assert.equal(second.signal.aborted, true);
  abortWakeStream(second);
  assert.equal(second.signal.aborted, true);
});

test("visibleEngineError redacts local home paths before publishing", () => {
  const message = visibleEngineError(
    "codex",
    "/Users/fayon/.king/agents/demo-agent",
    1,
    "failed in /Users/fayon/.king/agents/demo-agent/workspace and /Users/fayon/private.txt"
  );
  assert.match(message, /^local codex failed \(exit 1\):/);
  assert.doesNotMatch(message, /\/Users\/fayon\/\.king/);
  assert.doesNotMatch(message, /\/Users\/fayon\/private\.txt/);
  assert.match(message, /<agent home>\/workspace/);
  assert.match(message, /~\/private\.txt/);
});

test("sanitizeNestedEngineEnv removes outer runtime controls before spawning engines", () => {
  const clean = sanitizeNestedEngineEnv({
    PATH: "/bin",
    CODEX_CI: "1",
    CODEX_SANDBOX_NETWORK_DISABLED: "1",
    CODEX_THREAD_ID: "outer",
    CLAUDE_CODE_ENTRYPOINT: "outer",
    KING_AGENT_RUNTIME_URL: "outer",
    KING_AGENT_RUNTIME_TOKEN: "outer",
    KING_AGENT_RUNTIME_TENANT: "outer",
    KING_AGENT_WORKSPACE_ROOT: "outer",
    KING_AGENT_WORKTREE_PLAN: "outer",
    KING_AGENT_SKILL_SNAPSHOT_ID: "outer",
    KING_AGENT_SKILL_SNAPSHOT_PATH: "outer",
    KING_AGENT_SKILL_SNAPSHOT_MANIFEST: "outer",
    ORCA_SESSION_ID: "outer",
    OPENAI_CODEX_TRACE: "outer",
    KEEP_ME: "yes"
  } as NodeJS.ProcessEnv);

  assert.equal(clean.PATH, "/bin");
  assert.equal(clean.KEEP_ME, "yes");
  assert.equal(clean.CODEX_CI, undefined);
  assert.equal(clean.CODEX_SANDBOX_NETWORK_DISABLED, undefined);
  assert.equal(clean.CODEX_THREAD_ID, undefined);
  assert.equal(clean.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(clean.KING_AGENT_RUNTIME_URL, undefined);
  assert.equal(clean.KING_AGENT_RUNTIME_TOKEN, undefined);
  assert.equal(clean.KING_AGENT_RUNTIME_TENANT, undefined);
  assert.equal(clean.KING_AGENT_WORKSPACE_ROOT, undefined);
  assert.equal(clean.KING_AGENT_WORKTREE_PLAN, undefined);
  assert.equal(clean.KING_AGENT_SKILL_SNAPSHOT_ID, undefined);
  assert.equal(clean.KING_AGENT_SKILL_SNAPSHOT_PATH, undefined);
  assert.equal(clean.KING_AGENT_SKILL_SNAPSHOT_MANIFEST, undefined);
  assert.equal(clean.ORCA_SESSION_ID, undefined);
  assert.equal(clean.OPENAI_CODEX_TRACE, undefined);
});

test("swallowTurnRejection catches fire-and-forget turn errors", async () => {
  const seen: string[] = [];
  swallowTurnRejection(Promise.reject(new Error("boom")), (message) => seen.push(message));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["boom"]);
});
