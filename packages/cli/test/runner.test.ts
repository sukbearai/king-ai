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
  failOpenStreakAfterDeferral,
  formatTriageNote,
  formatSteerPrompt,
  isContextOverflow,
  isPoisonedTranscript,
  isRuntimeAuthError,
  isWakeStreamHealthy,
  isWakeStreamAuthFailure,
  mustResetSession,
  nextFailOpenStreak,
  nextNoStateActionStreak,
  parseWakeEventInfo,
  planEngineFailureAttempt,
  selectSteerMessage,
  Semaphore,
  sessionResetReason,
  simpleTurnFastPathInstruction,
  routedTaskTriageVerdict,
  shouldDeferFailOpenTriage,
  shouldFallbackAckSeen,
  shouldFallbackAckAfterStreak,
  shouldHandleWakeEvent,
  shouldContinuePendingRerun,
  shouldForceActionableTurn,
  shouldPreWarmEngineForWake,
  shouldPublishEngineFailureNotice,
  shouldRetryEngineNoOutputTurn,
  shouldSkipPollWake,
  shouldStopEngineOnBeginStop,
  replaceWakeStreamController,
  sanitizeNestedEngineEnv,
  swallowTurnRejection,
  unreadBatchKey,
  visibleEngineError,
  wakeEventKey
} from "../src/runner.js";

test("agentSessionFile scopes session ids by engine", () => {
  assert.match(agentSessionFile("king-ai-ceo", "claude"), /king-ai-ceo\.claude\.session$/);
  assert.match(agentSessionFile("king-ai-ceo", "codex"), /king-ai-ceo\.codex\.session$/);
});

test("parseWakeEventInfo extracts conversation and delivery latency", () => {
  assert.deepEqual(parseWakeEventInfo(undefined, 2000), {
    conversationId: null,
    requestId: null,
    messageId: null,
    taskId: null,
    agentId: null,
    sentAt: null,
    deliveryLatencyMs: null,
    resetState: false
  });
  assert.deepEqual(parseWakeEventInfo(JSON.stringify({ conversationId: "demo-convo", agentId: "dev", messageId: "msg-1", taskId: "task-1", at: 1500 }), 2000), {
    conversationId: "demo-convo",
    requestId: "msg-1",
    messageId: "msg-1",
    taskId: "task-1",
    agentId: "dev",
    sentAt: 1500,
    deliveryLatencyMs: 500,
    resetState: false
  });
  assert.deepEqual(parseWakeEventInfo("not json", 2000), {
    conversationId: null,
    requestId: null,
    messageId: null,
    taskId: null,
    agentId: null,
    sentAt: null,
    deliveryLatencyMs: null,
    resetState: false
  });
  assert.equal(parseWakeEventInfo(JSON.stringify({ at: 2500 }), 2000).deliveryLatencyMs, 0);
  assert.equal(parseWakeEventInfo(JSON.stringify({ resetState: true }), 2000).resetState, true);
});

test("shouldHandleWakeEvent keeps targeted wake events on the owning agent", () => {
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ agentId: "dev" })), "dev"), true);
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ agentId: "reviewer" })), "dev"), false);
  assert.equal(shouldHandleWakeEvent(parseWakeEventInfo(JSON.stringify({ conversationId: "all" })), "dev"), true);
});

test("shouldForceActionableTurn fast-paths SSE task wakes when inbox snapshot is empty", () => {
  assert.equal(shouldForceActionableTurn({ hasRealUnread: false, contract: { taskId: "task-1" } }), true);
  assert.equal(shouldForceActionableTurn({ hasRealUnread: true, contract: { taskId: "task-1" } }), false);
  assert.equal(shouldForceActionableTurn({ hasRealUnread: false, contract: { conversationId: "demo" } }), false);
  assert.equal(routedTaskTriageVerdict("task-1").actionable, true);
  assert.match(routedTaskTriageVerdict("task-1").reason ?? "", /task-1/);
});

test("shouldPreWarmEngineForWake only prewarms on SSE and reconnect wakes", () => {
  assert.equal(shouldPreWarmEngineForWake("sse-wake"), true);
  assert.equal(shouldPreWarmEngineForWake("reconnect-catchup"), true);
  assert.equal(shouldPreWarmEngineForWake("poll"), false);
});

test("wakeEventKey dedupes stable routed events without suppressing anonymous wakes", () => {
  assert.equal(
    wakeEventKey("wake", parseWakeEventInfo(JSON.stringify({ conversationId: "group", messageId: "msg-1", requestId: "req-1", taskId: "task-1" }))),
    "wake:group:msg-1"
  );
  assert.equal(
    wakeEventKey("steer", parseWakeEventInfo(JSON.stringify({ conversationId: "group", requestId: "req-1", taskId: "task-1" }))),
    "steer:group:req-1"
  );
  assert.equal(
    wakeEventKey("wake", parseWakeEventInfo(JSON.stringify({ conversationId: "group", taskId: "task-1" }))),
    "wake:group:task-1"
  );
  assert.equal(wakeEventKey("wake", parseWakeEventInfo(JSON.stringify({ conversationId: "group" }))), null);
  assert.equal(wakeEventKey("wake", parseWakeEventInfo(JSON.stringify({ messageId: "msg-1" }))), null);
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

test("mustResetSession follows King AI session reset rules", () => {
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
  assert.match(prompt, /king-ai reply demo-convo/);
  assert.match(prompt, /hello there/);
});

test("buildStandingPrompt documents King AI command habits", () => {
  const prompt = buildStandingPrompt(["/Users/fayon/workspace/github"], "/tmp/agents/demo-agent");
  assert.match(prompt, /Use the king-ai CLI on PATH/);
  assert.match(prompt, /Agent workspace root: \/tmp\/agents\/demo-agent/);
  assert.match(prompt, /\/Users\/fayon\/workspace\/github/);
  assert.match(prompt, /king-ai glance <conversationId>/);
  assert.match(prompt, /king-ai card claim <cardId>/);
  assert.match(prompt, /context get\|set\|list/);
  assert.match(prompt, /artifact put\|list\|get/);
  assert.match(prompt, /hypothesis create\|list\|update/);
  assert.match(prompt, /task list\|create\|update\|done/);
  assert.match(prompt, /king-ai reply <conversationId> --file notes\/reply\.md/);
  assert.match(prompt, /Shared skills:/);
  assert.match(prompt, /KING_AI_SHARED_SKILLS/);
  assert.match(prompt, /activation snapshot/);
  assert.match(prompt, /KING_AI_SKILL_SNAPSHOTS_DIR/);
  assert.match(prompt, /Learned skills \(self-evolution\)/);
  assert.match(prompt, /king-ai skill save <short-name> --file notes\/skill\.md/);
  assert.match(prompt, /recall <query>/);
  assert.match(prompt, /Host home entries:/);
  assert.match(prompt, /KING_AI_HOST_HOME_ENTRIES/);
  assert.match(prompt, /raised hands ordered by who started first/);
  assert.match(prompt, /Ordinary agent room chatter does not wake peers/);
  assert.match(prompt, /@<agent-id>/);
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
  assert.match(delta, /no need to re-run king-ai inbox or messages/);
  assert.match(delta, /Response mode: one-of-us/);
  assert.match(formatTriageNote({ actionable: true, routeHint: "steer", priority: "urgent" }), /Priority: urgent/);
  assert.match(formatTriageNote({ actionable: true, routeHint: "steer", priority: "urgent" }), /Route hint: steer/);
  assert.match(delta, /coordinate with glance\/claims/);
  assert.match(delta, /trust over memory/);
  assert.match(delta, /demo-agent\tDemo Agent/);
});

test("buildChatDelta adds simple-turn fast path only for directed work", () => {
  const routed = buildChatDelta("Human: 还有人在吗？", "memory", "dev\tDev", routedTaskTriageVerdict("task-1"));
  assert.match(routed, /Fast path for simple routed work/);
  assert.match(routed, /one brief reply and immediately close the assigned task/);
  assert.match(routed, /Do not run king-ai inbox, messages, or task list/);

  const directed = buildChatDelta("Human: ack?", "memory", "dev\tDev", { actionable: true, responseMode: "me" });
  assert.match(directed, /Fast path for simple routed work/);

  const shared = buildChatDelta("Human: any thoughts?", "memory", "dev\tDev", { actionable: true, responseMode: "one-of-us" });
  assert.doesNotMatch(shared, /Fast path for simple routed work/);
  assert.equal(simpleTurnFastPathInstruction({ actionable: false, responseMode: "me" }), "");
});

test("formatTriageNote explains all King AI response modes", () => {
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

test("wake stream auth failures are terminal statuses", () => {
  assert.equal(isWakeStreamAuthFailure(401), true);
  assert.equal(isWakeStreamAuthFailure(403), true);
  assert.equal(isWakeStreamAuthFailure(500), false);
  assert.equal(isWakeStreamAuthFailure(429), false);
});

test("no-output engine failures reset persistent sessions", () => {
  const error = "local codex failed (exit 124): codex engine produced no output for 300s after session.send";
  assert.equal(mustResetSession(error, false), true);
  assert.equal(sessionResetReason(error), "engine produced no output");
  assert.equal(shouldRetryEngineNoOutputTurn({ error, attempts: 0 }), true);
  assert.equal(shouldRetryEngineNoOutputTurn({ error, attempts: 1 }), false);
  assert.equal(shouldRetryEngineNoOutputTurn({ error: "not logged in", attempts: 0 }), false);
  assert.deepEqual(planEngineFailureAttempt({ error, attempts: 0 }), {
    retry: true,
    publishFailureNotice: false,
    nextAttempts: 1
  });
  assert.deepEqual(planEngineFailureAttempt({ error, attempts: 1 }), {
    retry: false,
    publishFailureNotice: true,
    nextAttempts: 1
  });
  assert.deepEqual(planEngineFailureAttempt({ error: "not logged in", attempts: 0 }), {
    retry: false,
    publishFailureNotice: true,
    nextAttempts: 0
  });
});

test("runtime auth errors are detected from strict runtime failures", () => {
  assert.equal(isRuntimeAuthError('GET /inbox -> HTTP 401 {"error":"invalid runtime token"}'), true);
  assert.equal(isRuntimeAuthError("POST /status -> HTTP 403 forbidden"), true);
  assert.equal(isRuntimeAuthError("GET /inbox -> HTTP 500 Internal Server Error"), false);
  assert.equal(isRuntimeAuthError("HTTP 4012 is not an auth status"), false);
});

test("engine failures publish user-facing notices even for quota and rate limits", () => {
  assert.equal(shouldPublishEngineFailureNotice("usage limit reached"), true);
  assert.equal(shouldPublishEngineFailureNotice("HTTP 429 too many requests"), true);
  assert.equal(shouldPublishEngineFailureNotice("not logged in"), true);
  assert.equal(shouldPublishEngineFailureNotice(""), false);
});

test("visibleEngineError redacts local home paths before publishing", () => {
  const message = visibleEngineError(
    "codex",
    "/Users/fayon/.king-ai/agents/demo-agent",
    1,
    "failed in /Users/fayon/.king-ai/agents/demo-agent/workspace and /Users/fayon/private.txt"
  );
  assert.match(message, /^local codex failed \(exit 1\):/);
  assert.doesNotMatch(message, /\/Users\/fayon\/\.king-ai/);
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
    KING_AI_AGENT_RUNTIME_URL: "outer",
    KING_AI_AGENT_RUNTIME_TOKEN: "outer",
    KING_AI_AGENT_RUNTIME_TENANT: "outer",
    KING_AI_AGENT_WORKSPACE_ROOT: "outer",
    KING_AI_AGENT_WORKTREE_PLAN: "outer",
    KING_AI_AGENT_SKILL_SNAPSHOT_ID: "outer",
    KING_AI_AGENT_SKILL_SNAPSHOT_PATH: "outer",
    KING_AI_AGENT_SKILL_SNAPSHOT_MANIFEST: "outer",
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
  assert.equal(clean.KING_AI_AGENT_RUNTIME_URL, undefined);
  assert.equal(clean.KING_AI_AGENT_RUNTIME_TOKEN, undefined);
  assert.equal(clean.KING_AI_AGENT_RUNTIME_TENANT, undefined);
  assert.equal(clean.KING_AI_AGENT_WORKSPACE_ROOT, undefined);
  assert.equal(clean.KING_AI_AGENT_WORKTREE_PLAN, undefined);
  assert.equal(clean.KING_AI_AGENT_SKILL_SNAPSHOT_ID, undefined);
  assert.equal(clean.KING_AI_AGENT_SKILL_SNAPSHOT_PATH, undefined);
  assert.equal(clean.KING_AI_AGENT_SKILL_SNAPSHOT_MANIFEST, undefined);
  assert.equal(clean.ORCA_SESSION_ID, undefined);
  assert.equal(clean.OPENAI_CODEX_TRACE, undefined);
});

test("swallowTurnRejection catches fire-and-forget turn errors", async () => {
  const seen: string[] = [];
  swallowTurnRejection(Promise.reject(new Error("boom")), (message) => seen.push(message));

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["boom"]);
});

test("shouldSkipPollWake defers inbox poll while wake-stream is healthy", () => {
  const now = 100_000;
  assert.equal(shouldSkipPollWake({ busy: false, stopped: false, wakeStreamHealthy: true }), true);
  assert.equal(shouldSkipPollWake({ busy: false, stopped: false, wakeStreamHealthy: false }), false);
  assert.equal(isWakeStreamHealthy(now - 10_000, now, 20_000), true);
  assert.equal(isWakeStreamHealthy(now - 80_000, now, 20_000), false);
});

test("shouldFallbackAckSeen only applies when run actions are missing", () => {
  assert.equal(shouldFallbackAckSeen(false, 2), true);
  assert.equal(shouldFallbackAckSeen(true, 2), false);
  assert.equal(shouldFallbackAckSeen(false, 0), false);
});

test("no-state-action streak grants a grace turn before fallback-acking unread", () => {
  // A successful ack resets the streak; consecutive no-action turns accumulate it.
  assert.equal(nextNoStateActionStreak(0, true), 0);
  assert.equal(nextNoStateActionStreak(3, true), 0);
  const first = nextNoStateActionStreak(0, false);
  assert.equal(first, 1);
  // First no-action turn is a grace turn (no fallback-ack yet).
  assert.equal(shouldFallbackAckAfterStreak(first), false);
  const second = nextNoStateActionStreak(first, false);
  assert.equal(second, 2);
  // Same unread still unhandled after a second turn: now the fallback-ack fires.
  assert.equal(shouldFallbackAckAfterStreak(second), true);
});

test("pending reruns only continue when fresh unread work remains", () => {
  assert.equal(shouldContinuePendingRerun({ pendingRerun: false, hasRealUnread: true, hasAgendaWork: false, hasPinnedTask: false, stopped: false }), false);
  assert.equal(shouldContinuePendingRerun({ pendingRerun: true, hasRealUnread: false, hasAgendaWork: false, hasPinnedTask: false, stopped: false }), false);
  assert.equal(shouldContinuePendingRerun({ pendingRerun: true, hasRealUnread: true, hasAgendaWork: false, hasPinnedTask: false, stopped: true }), false);
  assert.equal(shouldContinuePendingRerun({ pendingRerun: true, hasRealUnread: true, hasAgendaWork: false, hasPinnedTask: false, stopped: false }), true);
  assert.equal(shouldContinuePendingRerun({ pendingRerun: true, hasRealUnread: false, hasAgendaWork: true, hasPinnedTask: false, stopped: false }), true);
  assert.equal(shouldContinuePendingRerun({ pendingRerun: true, hasRealUnread: false, hasAgendaWork: false, hasPinnedTask: true, stopped: false }), true);
});

test("unreadBatchKey changes when the unread batch changes", () => {
  assert.equal(
    unreadBatchKey(new Map([["b", "2"], ["a", "1"]])),
    unreadBatchKey(new Map([["a", "1"], ["b", "2"]]))
  );
  assert.notEqual(
    unreadBatchKey(new Map([["demo", "msg-1"]])),
    unreadBatchKey(new Map([["demo", "msg-2"]]))
  );
});

test("no-state-action streak resets when the unread batch changes", () => {
  let streak = nextNoStateActionStreak(0, false);
  let key = unreadBatchKey(new Map([["demo", "msg-1"]]));
  assert.equal(streak, 1);

  const nextKey = unreadBatchKey(new Map([["demo", "msg-2"]]));
  if (nextKey !== key) {
    key = nextKey;
    streak = 0;
  }
  streak = nextNoStateActionStreak(streak, false);

  assert.equal(key, nextKey);
  assert.equal(streak, 1);
  assert.equal(shouldFallbackAckAfterStreak(streak), false);
});

test("nextFailOpenStreak and shouldDeferFailOpenTriage cap repeated fail-open triage", () => {
  assert.equal(nextFailOpenStreak(0, "local"), 0);
  assert.equal(nextFailOpenStreak(1, "fail-open"), 2);
  assert.equal(shouldDeferFailOpenTriage(2), false);
  assert.equal(shouldDeferFailOpenTriage(3), true);
  assert.equal(failOpenStreakAfterDeferral(3), 0);
  assert.equal(shouldDeferFailOpenTriage(failOpenStreakAfterDeferral(3)), false);
  assert.equal(nextFailOpenStreak(3, "local"), 0);
  assert.equal(nextFailOpenStreak(2, "fail-open", true), 0);
});
