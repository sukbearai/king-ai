/// <reference types="@cloudflare/workers-types" />

import {
  authForRequest,
  authUserFromRequest,
  bearer,
  displayNameForAuthUser,
  forwardHeaders,
  getAuthUser,
  pairingLocator,
  publicBaseUrl,
  remoteAssistTenantFromRequest,
  requireGuiAuth,
  requireOwnerGuiAuth,
  sanitizeTenantId,
  splitPairCode,
  stateForRequest,
  stateForTenant,
  tenantForGuiRequest,
  tenantFromRequest
} from "./gui-auth.js";
import { encode, json, requestKeepAlive } from "./gui-http.js";
import { createGuiApp } from "./gui-routes.js";
import {
  CLI_LOG_CAPACITY,
  DEFAULT_AGENT,
  DEFAULT_CONVERSATION,
  DEFAULT_EVALUATION_CRITERIA,
  DEFAULT_NEW_CONVERSATION_WORKFLOW_ID,
  DEFAULT_TEAM_AGENTS,
  EVENT_LOG_CAPACITY,
  GUI_ATTACHMENT_CHUNK_CHARS,
  GUI_ATTACHMENT_MAX_BYTES,
  GUI_ATTACHMENT_STORE_CAPACITY,
  GUI_BASE_STATE_KEY,
  GUI_ENTITY_STATE_KEYS,
  IELTS_WORKFLOW_AGENTS,
  LOOP_EVENT_BUFFER_CAPACITY,
  NOTICE_LOG_CAPACITY,
  REVIEW_COVERAGE_GATE,
  RUNTIME_TOKEN_TTL_MS,
  RUN_LOG_CAPACITY,
  RUN_STREAM_CAPACITY,
  SAFETY_ACTIONS,
  SAFETY_AUTO_ALLOW,
  STATUS_LOG_CAPACITY,
  THINKING_LOG_CAPACITY,
  TRIAGE_LOG_CAPACITY,
  TYPING_LOG_CAPACITY,
  WAKE_LOG_CAPACITY,
  WORKFLOW_TEMPLATES
} from "./gui-types.js";
import type {
  Agent,
  AgentLifecycle,
  AgentStateSummary,
  AgentConfigPayload,
  AgendaPayload,
  ApprovalRequest,
  Artifact,
  ArtifactQualityCheck,
  AuthUser,
  Bindings,
  CalendarItem,
  CapsuleScopeType,
  CapsuleStatus,
  Card,
  ChangeCapsule,
  Claim,
  ComposingClaim,
  ContextEntry,
  Conversation,
  ConversationTeamSnapshot,
  Doc,
  EntityState,
  EntityStateKey,
  Env,
  EvaluationCriteria,
  EvaluationRecord,
  EvaluationScore,
  EventRoute,
  ExecutionPlan,
  ExternalEvent,
  GuiCardMovePayload,
  GuiConversationPayload,
  GuiTaskPayload,
  GuiTaskUpdatePayload,
  GuiWorkflowAgentsPayload,
  Hypothesis,
  HypothesisStatus,
  LoopClassification,
  LoopEvent,
  LoopEventType,
  LoopSnapshot,
  MergeRequest,
  MergeStatus,
  Message,
  PairPayload,
  PlannedTask,
  Reaction,
  RemoteAssistGrant,
  RequestContext,
  ReviewRecord,
  RunAction,
  RunContract,
  RunFeedback,
  RuntimeTokenMeta,
  SafetyAction,
  State,
  StateSnapshot,
  Task,
  TaskEvent,
  TaskEventType,
  TaskReviewResult,
  TaskStatus,
  UploadedAttachment,
  WorkflowTemplate
} from "./gui-types.js";
import {
  resolveWakeEvent,
  resolveWakeData,
  shouldAutoDelegateMessage,
  triageResponseMode,
  wakeEventVisibleToAgent
} from "./runtime-helpers.js";
import {
  addGuiTaskToState as workflowAddGuiTaskToState,
  createGuiTaskDraft as workflowCreateGuiTaskDraft,
  updateGuiTaskFromPatch as workflowUpdateGuiTaskFromPatch,
  wakeResolveContextFromState
} from "./workflow-state.js";
import { runAgentsCommand } from "./gui-cli-agents.js";
import { runCalendarCommand } from "./gui-cli-calendar.js";
import { runCardCommand } from "./gui-cli-card.js";
import { runClaimCommand, runUnclaimCommand } from "./gui-cli-claim.js";
import { runContextCommand } from "./gui-cli-context.js";
import { runDocCommand } from "./gui-cli-doc.js";
import { runCapsuleCommand } from "./gui-cli-capsule.js";
import { runEvalCommand } from "./gui-cli-eval.js";
import { runFeedbackCommand } from "./gui-cli-feedback.js";
import { runInitiativeCommand } from "./gui-cli-initiative.js";
import { runLoopCommand } from "./gui-cli-loop.js";
import { runMergeCommand } from "./gui-cli-merge.js";
import {
  runDmCommand,
  runEscalateCommand,
  runRecvCommand,
  runSendCommand
} from "./gui-cli-messaging.js";
import { runObserveCommand } from "./gui-cli-observe.js";
import { runHypothesisCommand } from "./gui-cli-hypothesis.js";
import { runPlanCommand } from "./gui-cli-plan.js";
import { runReactCommand } from "./gui-cli-react.js";
import { runReviewCommand } from "./gui-cli-review.js";
import { runRouteCommand } from "./gui-cli-route.js";
import { runSafetyCommand } from "./gui-cli-safety.js";
import { runStateCommand } from "./gui-cli-state.js";
import { runTaskCommand } from "./gui-cli-task.js";
import { runArtifactCommand } from "./gui-cli-artifact.js";
import { dispatchRuntimeCli } from "./runtime-cli-dispatch.js";
import { indexEpisodicMessages, runRecallCommand, type SqlLike } from "./episodic.js";
import {
  artifactCandidateFromArgs as artifactCandidateFromArgsHelper,
  checkArtifactQuality as checkArtifactQualityHelper,
  findArtifactInState,
  formatArtifactLine as formatArtifactLineHelper,
  formatArtifactQualityCheck as formatArtifactQualityCheckHelper,
  parseMetadataJson as parseMetadataJsonHelper,
  STANDARD_ARTIFACT_KINDS
} from "./artifact-helpers.js";
import { cronMatches, parseCron } from "@suwujs/king-ai/cron";
import { normalizeRuntimeAttachments } from "@suwujs/king-ai/attachments";
import type { RuntimeAttachment } from "@suwujs/king-ai/attachments";
import { initialRunStreamState, reduceRunStream, renderRunStreamCard } from "@suwujs/king-ai/run-stream";
import type { RunStreamState } from "@suwujs/king-ai/run-stream";
import { formatMessageRouteSummary, messageRouteTag, sortRuntimeMessages } from "@suwujs/king-ai/message-routing";
import type { RunFeedbackSummary } from "./gui-runtime.js";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function displayNameForHuman(state: State, user: AuthUser | undefined): string {
  const fromAuth = displayNameForAuthUser(user);
  if (fromAuth !== "King AI Human") return fromAuth;
  const fromMessages = [...state.messages].reverse().find((message) => message.author_kind === "human" && message.author_name.trim());
  return fromMessages?.author_name.trim() || fromAuth;
}

function formatNoticeSummary(body: unknown): string {
  if (!body || typeof body !== "object") return summarizeUnknown(body);
  const notice = body as { noticeKind?: unknown; text?: unknown };
  if (notice.noticeKind === "byoa_engine_failed" && typeof notice.text === "string" && notice.text.trim()) {
    return notice.text.replace(/\s+/g, " ").slice(0, 220);
  }
  if (typeof notice.noticeKind === "string") return notice.noticeKind;
  return summarizeUnknown(body);
}

const app = createGuiApp({
  requireGuiAuth,
  requireOwnerGuiAuth,
  stateForRequest,
  stateForTenant,
  forwardHeaders,
  authForRequest,
  splitPairCode,
  sanitizeTenantId,
  tenantFromRequest
});

export class GuiState implements DurableObject {
  private waiters = new Set<{ agentId: string; gui?: boolean; writer: WritableStreamDefaultWriter<Uint8Array> }>();
  private persistedStateFingerprint = new Map<string, string>();
  private episodicIndexedIds = new Set<string>();

  constructor(private state: DurableObjectState) {}

  private episodicSql(): SqlLike | undefined {
    const sql = (this.state.storage as { sql?: SqlLike }).sql;
    return sql && typeof sql.exec === "function" ? sql : undefined;
  }

  // Best-effort: mirror new human/agent messages into the FTS5 episodic index. Never let an
  // indexing hiccup break state persistence, and skip ids we have already indexed this lifetime.
  private indexEpisodic(state: State): void {
    const sql = this.episodicSql();
    if (!sql) return;
    const fresh = state.messages.filter((message) => message.id && !this.episodicIndexedIds.has(message.id));
    if (fresh.length === 0) return;
    try {
      indexEpisodicMessages(sql, fresh);
    } catch {
      // FTS index is additive; persistence and the live UI must not depend on it.
    }
    for (const message of fresh) if (message.id) this.episodicIndexedIds.add(message.id);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/pair") return this.pair(await request.json().catch(() => ({})) as PairPayload, request);
    if (path === "/agents") return this.authDevice(request, async () => json((await this.get()).agents));
    if (path === "/heartbeat") return this.authDevice(request, async () => this.heartbeat(await request.json().catch(() => ({}))));
    if (path.startsWith("/runtime-token/")) return this.authDevice(request, async () => this.runtimeToken(path.split("/")[2]));
    if (path === "/wake-stream") return this.authRuntime(request, async (agentId) => this.wakeStream(agentId));
    if (path === "/inbox") return this.authRuntime(request, async (agentId) => this.inbox(agentId));
    if (path === "/triage") return this.authRuntime(request, async (agentId) => this.triage(agentId));
    if (path === "/agenda") return this.authRuntime(request, async (agentId) => this.agenda(agentId));
    if (path === "/roster") return this.authRuntime(request, async () => this.roster());
    if (path === "/preamble") return this.authRuntime(request, async () => this.preamble(url.searchParams));
    if (path === "/cli") return this.authRuntime(request, async (agentId) => this.cli({ ...await request.json() as { argv?: string[]; agentId?: string }, tokenAgentId: agentId, authUser: authUserFromRequest(request) }));
    if (path === "/mark-read") return this.authRuntime(request, async (agentId) => this.markRead(await request.json() as { conversationId?: string; upToMessageId?: string }, agentId));
    if (path === "/status") return this.authRuntime(request, async (agentId) => this.status(await request.json() as { status?: string }, agentId));
    if (path === "/typing") return this.authRuntime(request, async (agentId) => this.typing(await request.json() as { conversationId?: string; done?: boolean }, agentId));
    if (path === "/thinking/mark") return this.authRuntime(request, async (agentId) => this.thinking("mark", await request.json() as { conversationIds?: string[] }, agentId));
    if (path === "/thinking/unmark") return this.authRuntime(request, async (agentId) => this.thinking("unmark", await request.json() as { conversationIds?: string[] }, agentId));
    if (path === "/events") return this.authRuntime(request, async () => this.events(await request.json().catch(() => null)));
    if (path === "/notices") return this.authRuntime(request, async () => this.logBody("noticeLog", await request.json().catch(() => null)));
    if (path === "/triage-log") return this.authRuntime(request, async () => this.logBody("triageLog", await request.json().catch(() => null)));
    if (path === "/runs") return this.authRuntime(request, async () => this.startRun(await request.json().catch(() => null)));
    if (path.startsWith("/runs/") && path.endsWith("/heartbeat")) return this.authRuntime(request, async () => this.runAction(path.split("/")[2] || "run", "heartbeat", await request.json().catch(() => null)));
    if (path.startsWith("/runs/") && path.endsWith("/finish")) return this.authRuntime(request, async () => this.runAction(path.split("/")[2] || "run", "finish", await request.json().catch(() => null)));
    if (path.startsWith("/runs/") && path.endsWith("/actions")) return this.authRuntime(request, async (agentId) => this.runActions(path.split("/")[2] || "run", agentId));
    if (path === "/gui-events") return this.guiEvents();
    if (path === "/gui-state") return json(await stateForGui(await this.get(), url.searchParams.get("redact") === "1"));
    if (path === "/gui-summary") return this.guiSummary(request);
    if (path === "/gui-activity") return this.guiActivity(url.searchParams);
    if (path === "/gui-storage-debug") return this.storageDebug();
    if (path === "/gui-export-state") return json(this.snapshot(await this.get()));
    if (path === "/gui-import-state") return this.importSnapshot(await request.json().catch(() => null));
    if (path === "/gui-reset-state") return this.resetState();
    if (path === "/gui-message") return this.guiMessage(request, await request.json() as { body?: string; conversationId?: string; attachments?: unknown });
    if (path === "/gui-attachments" && request.method === "POST") return this.guiAttachment(request, await request.json().catch(() => ({})));
    if (path.startsWith("/gui-attachments/") && request.method === "GET") return this.guiAttachmentFile(new URL(request.url), decodeURIComponent(path.slice("/gui-attachments/".length)));
    if (path === "/gui-conversations") return this.guiConversation(await request.json().catch(() => ({})) as GuiConversationPayload);
    if (path.startsWith("/gui-conversations/") && path.endsWith("/team")) return this.guiUpdateConversationTeam(path.split("/")[2], await request.json().catch(() => ({})) as GuiConversationPayload);
    if (path.startsWith("/gui-workflows/") && path.endsWith("/agents")) return this.guiUpdateWorkflowAgents(path.split("/")[2], await request.json().catch(() => ({})) as GuiWorkflowAgentsPayload);
    if (path.startsWith("/gui-conversations/") && path.endsWith("/delete")) return this.guiDeleteConversation(path.split("/")[2]);
    if (path === "/gui-clear-messages") return this.clearMessages(await request.json().catch(() => ({})) as { conversationId?: string });
    if (path === "/gui-agent-config") return this.agentConfig(await request.json() as AgentConfigPayload);
    if (path === "/gui-card") return this.createCard(await request.json().catch(() => ({})) as { title?: string; assignee?: string; allowedPaths?: string[] });
    if (path === "/gui-task") return this.createTask(await request.json().catch(() => ({})) as GuiTaskPayload);
    if (path.startsWith("/gui-task/") && path.endsWith("/update")) return this.updateTask(path.split("/")[2], await request.json().catch(() => ({})) as GuiTaskUpdatePayload);
    if (path.startsWith("/gui-card/") && path.endsWith("/move")) return this.moveCard(path.split("/")[2], await request.json().catch(() => ({})) as GuiCardMovePayload);
    if (path === "/gui-conversation/mark-read") return this.guiMarkRead(await request.json().catch(() => ({})) as { conversationId?: string; upToMessageId?: string });
    if (path === "/gui-wake") return this.guiWake(await request.json().catch(() => ({})));
    if (path === "/gui-remote-assist/share") return this.remoteAssistShare(request);
    if (path === "/gui-remote-assist/revoke") return this.remoteAssistRevoke();
    if (path === "/remote-assist/auth") return this.remoteAssistAuth(await request.json().catch(() => ({})) as { token?: unknown });
    if (path.startsWith("/gui-approval/") && path.endsWith("/resolve")) return this.resolveApproval(path.split("/")[2] || "", await request.json().catch(() => ({})) as { decision?: string; reason?: string });
    return json({ error: "not found" }, { status: 404 });
  }

  private async get(): Promise<State> {
    const saved = await this.state.storage.get<State>(GUI_BASE_STATE_KEY);
    if (saved) {
      const normalized = this.normalizeState(await this.hydrateEntityState(saved));
      return normalized;
    }
    const initial = this.freshState();
    await this.put(initial);
    return initial;
  }

  private async hydrateEntityState(base: State): Promise<State> {
    const entries = await Promise.all(GUI_ENTITY_STATE_KEYS.map(async (key) => [key, await this.state.storage.get<State[typeof key]>(entityStateStorageKey(key))] as const));
    const state = { ...base };
    this.persistedStateFingerprint.set(GUI_BASE_STATE_KEY, stableStorageValue(base));
    for (const [key, value] of entries) {
      if (value !== undefined) {
        (state as unknown as EntityState)[key] = value as never;
        this.persistedStateFingerprint.set(entityStateStorageKey(key), stableStorageValue(value));
      }
    }
    return state;
  }

  private async put(state: State, options: { force?: boolean } = {}): Promise<void> {
    this.indexEpisodic(state);
    const base = stripEntityState(state);
    const writes: Promise<unknown>[] = [];
    this.queueStateWrite(writes, GUI_BASE_STATE_KEY, base, options.force === true);
    for (const key of GUI_ENTITY_STATE_KEYS) {
      this.queueStateWrite(writes, entityStateStorageKey(key), state[key], options.force === true);
    }
    await Promise.all(writes);
  }

  private async putBaseState(state: State): Promise<void> {
    const writes: Promise<unknown>[] = [];
    this.queueStateWrite(writes, GUI_BASE_STATE_KEY, stripEntityState(state));
    await Promise.all(writes);
  }

  private async clearEntityState(): Promise<void> {
    await Promise.all([
      this.state.storage.delete(GUI_BASE_STATE_KEY),
      ...GUI_ENTITY_STATE_KEYS.map((key) => this.state.storage.delete(entityStateStorageKey(key)))
    ]);
    this.persistedStateFingerprint.clear();
  }

  private async storageDebug(): Promise<Response> {
    const keys = [GUI_BASE_STATE_KEY, ...GUI_ENTITY_STATE_KEYS.map(entityStateStorageKey)];
    const rows = await Promise.all(keys.map(async (key) => ({ key, present: (await this.state.storage.get(key)) !== undefined })));
    const base = await this.state.storage.get<Record<string, unknown>>(GUI_BASE_STATE_KEY);
    return json({ rows, baseKeys: Object.keys(base ?? {}).sort() });
  }

  private queueStateWrite(writes: Promise<unknown>[], key: string, value: unknown, force = false): void {
    const fingerprint = stableStorageValue(value);
    if (!force && this.persistedStateFingerprint.get(key) === fingerprint) return;
    writes.push(this.state.storage.put(key, value).then(() => {
      this.persistedStateFingerprint.set(key, fingerprint);
    }));
  }

  private freshState(): State {
    const initial: State = {
      computerId: "king-computer",
      deviceToken: crypto.randomUUID(),
      runtimeToken: crypto.randomUUID(),
      runtimeTokens: {},
      runtimeTokenMeta: {},
      pairingCode: crypto.randomUUID(),
	      availableEngines: [],
	      capabilities: { workspaces: [] },
	      agents: defaultTeamAgents(),
	      workflowAgentIds: normalizeWorkflowAgentIds(undefined, defaultTeamAgents()),
	      conversations: [{ ...DEFAULT_CONVERSATION, created_at: Date.now(), updated_at: Date.now() }],
      messages: [],
      cliLog: [],
      statusLog: [],
      typingLog: [],
      thinkingLog: [],
      eventLog: [],
      wakeLog: [],
      eventRoutes: [],
      loopRunId: "run-gui",
      currentLoop: 0,
      loopEvents: [],
      noticeLog: [],
      triageLog: [],
      runLog: [],
      runStreams: {},
      activeRunContracts: {},
      runActions: {},
      initiatives: [],
      tasks: [],
      taskEvents: [],
      capsules: [],
      mergeQueue: [],
      evaluations: [],
      runFeedback: [],
      reviews: [],
      cards: [],
      calendar: [],
      claims: [],
      docs: [],
      artifacts: [],
      context: [],
      hypotheses: [],
	      reactions: [],
	      composing: [],
	      approvals: [],
	      uploads: {},
	      remoteAssist: undefined
	    };
    return initial;
  }

  private normalizeState(saved: State): State {
    saved.initiatives ??= [];
    saved.runtimeToken ??= crypto.randomUUID();
    saved.runtimeTokens ??= {};
    saved.runtimeTokenMeta ??= {};
    saved.capsules ??= [];
    saved.approvals ??= [];
    saved.mergeQueue ??= [];
    saved.evaluations ??= [];
    saved.runFeedback ??= [];
    saved.reviews ??= [];
    saved.eventRoutes ??= [];
    saved.loopRunId ??= "run-gui";
    saved.currentLoop ??= 0;
    saved.loopEvents ??= [];
    saved.cards ??= [];
    saved.calendar ??= [];
    saved.claims ??= [];
    saved.docs ??= [];
    saved.artifacts ??= [];
    saved.context ??= [];
    saved.hypotheses ??= [];
	    saved.reactions ??= [];
	    saved.composing ??= [];
	    saved.uploads ??= {};
	    saved.runtimeTokens = normalizeRuntimeTokens(saved.runtimeTokens);
    saved.runtimeTokenMeta = normalizeRuntimeTokenMeta(saved.runtimeTokenMeta, saved.runtimeTokens);
    saved.remoteAssist = normalizeRemoteAssistGrant(saved.remoteAssist);
    saved.agents = normalizeAgents(saved.agents);
    saved.workflowAgentIds = normalizeWorkflowAgentIds(saved.workflowAgentIds, saved.agents);
    saved.messages = normalizeMessages(saved.messages ?? []);
    saved.tasks = normalizeTasks(saved.tasks ?? []);
    saved.taskEvents = normalizeTaskEvents(saved.taskEvents ?? []);
    saved.cards = normalizeCards(saved.cards ?? []);
    saved.calendar = normalizeCalendar(saved.calendar ?? []);
    saved.claims = normalizeClaims(saved.claims ?? []);
    saved.capsules = normalizeCapsules(saved.capsules ?? []);
    saved.mergeQueue = normalizeMergeQueue(saved.mergeQueue ?? []);
    saved.artifacts = normalizeArtifacts(saved.artifacts ?? []);
    saved.context = normalizeContext(saved.context ?? []);
    saved.hypotheses = normalizeHypotheses(saved.hypotheses ?? []);
    saved.reactions = normalizeReactions(saved.reactions ?? []);
    saved.composing = normalizeComposing(saved.composing ?? []);
    saved.conversations = normalizeConversations(saved.conversations, saved.messages ?? []);
    for (const conversation of saved.conversations) {
      const team = normalizeConversationTeam(saved, {}, conversation);
      conversation.teamMode = team.teamMode;
      conversation.coordinatorAgentId = team.coordinatorAgentId;
      conversation.teamAgentIds = team.teamAgentIds;
      conversation.teamSnapshot ??= buildConversationTeamSnapshot(saved, team, {}, conversation.created_at || Date.now());
    }
    saved.cliLog = (saved.cliLog ?? []).slice(-CLI_LOG_CAPACITY);
    saved.statusLog = (saved.statusLog ?? []).slice(-STATUS_LOG_CAPACITY);
    saved.typingLog = (saved.typingLog ?? []).slice(-TYPING_LOG_CAPACITY);
    saved.thinkingLog = (saved.thinkingLog ?? []).slice(-THINKING_LOG_CAPACITY);
    saved.eventLog = (saved.eventLog ?? []).slice(-EVENT_LOG_CAPACITY);
    saved.wakeLog = (saved.wakeLog ?? []).slice(-WAKE_LOG_CAPACITY);
    saved.noticeLog = (saved.noticeLog ?? []).slice(-NOTICE_LOG_CAPACITY);
    saved.triageLog = (saved.triageLog ?? []).slice(-TRIAGE_LOG_CAPACITY);
    saved.runLog = (saved.runLog ?? []).slice(-RUN_LOG_CAPACITY);
    saved.runStreams = pruneRunStreams(saved.runStreams ?? {});
    saved.activeRunContracts = pruneActiveRunContracts(saved.activeRunContracts ?? {});
    saved.runActions = pruneRunActions(saved.runActions ?? {});
    saved.capabilities ??= { workspaces: [] };
    saved.availableEngines ??= [];
    return saved;
  }

  private snapshot(state: State): StateSnapshot {
    return {
      schema: "king-ai.gui-state.v1",
      exportedAt: Date.now(),
      state
    };
  }

  private async importSnapshot(payload: unknown): Promise<Response> {
    if (!payload || typeof payload !== "object") return json({ error: "expected state snapshot JSON" }, { status: 400 });
    const record = payload as Partial<StateSnapshot> & { state?: unknown };
    if (record.schema !== "king-ai.gui-state.v1" || !record.state || typeof record.state !== "object") {
      return json({ error: "unsupported or malformed state snapshot" }, { status: 400 });
    }
    const incoming = this.normalizeState(record.state as State);
    if (!incoming.computerId || !incoming.deviceToken || !incoming.runtimeToken || !incoming.pairingCode) {
      return json({ error: "snapshot is missing pairing tokens" }, { status: 400 });
    }
    await this.put(incoming, { force: true });
    await this.broadcast({ event: "wake", data: { importedState: true, at: Date.now() } });
    return json({ ok: true, messages: incoming.messages.length, agents: incoming.agents.length });
  }

  private async resetState(): Promise<Response> {
    const fresh = this.freshState();
    await this.put(fresh, { force: true });
    await this.broadcast({ event: "wake", data: { resetState: true, at: Date.now() } });
    return json({ ok: true, computerId: fresh.computerId });
  }

  private async pair(payload: PairPayload | undefined, request: Request): Promise<Response> {
    const state = await this.get();
    if (typeof payload?.code !== "string" || payload.code !== state.pairingCode) {
      return json({ error: "invalid pairing code" }, { status: 401 });
    }
    state.availableEngines = Array.isArray(payload?.engines) ? payload.engines.filter((engine): engine is string => typeof engine === "string") : [];
    state.capabilities = normalizeCapabilities(payload?.capabilities);
    state.pairingCode = crypto.randomUUID();
    await this.putBaseState(state);
    return json({ computerId: state.computerId, deviceToken: state.deviceToken, tenantId: tenantHeader(request) });
  }

  private async runtimeToken(agentIdRaw?: string): Promise<Response> {
    const state = await this.get();
    const agentId = normalizeAgentId(decodeURIComponent(agentIdRaw || "")) ?? "";
    const agent = findAgent(state, agentId) ?? defaultAgentFor(state);
    state.runtimeTokens ??= {};
    state.runtimeTokenMeta ??= {};
    const runtimeToken = crypto.randomUUID();
    const expiresAt = Date.now() + RUNTIME_TOKEN_TTL_MS;
    state.runtimeTokens[agent.id] = runtimeToken;
    state.runtimeTokenMeta[agent.id] = { token: runtimeToken, expiresAt };
    if (agent.id === DEFAULT_AGENT.id) state.runtimeToken = runtimeToken;
    await this.put(state);
    return json({ token: runtimeToken, expiresInSeconds: Math.floor(RUNTIME_TOKEN_TTL_MS / 1000) });
  }

  private async heartbeat(payload?: unknown): Promise<Response> {
    const state = await this.get();
    const body = payload && typeof payload === "object" ? payload as { version?: unknown; capabilities?: unknown } : {};
    const capabilities = normalizeCapabilities(body.capabilities);
    state.capabilities = capabilities;
    state.lastHeartbeat = {
      at: Date.now(),
      version: typeof body.version === "string" ? body.version : undefined,
      capabilities
    };
    await this.put(state);
    return json({ ok: true, at: state.lastHeartbeat.at });
  }

  private async guiSummary(request: Request): Promise<Response> {
    const state = await this.get();
    const agent = defaultAgentFor(state);
    const agentSummary = agentStateSummary(state, agent);
    const observation = buildLoopSnapshot(state);
    const lastRunStart = state.runLog.slice().reverse().find((row) => row.action === "start");
    const lastRunFinish = state.runLog.slice().reverse().find((row) => row.action === "finish");
    const lastHeartbeatAt = state.lastHeartbeat?.at;
    const paired = state.availableEngines.length > 0;
    const online = Boolean(lastHeartbeatAt && Date.now() - lastHeartbeatAt < 90_000);
    const unread = unreadMessagesFor(state, DEFAULT_AGENT.id);
    const tenantId = tenantHeader(request);
    const encodedPairingCode = tenantId === "global" ? state.pairingCode : `${tenantId}:${state.pairingCode}`;
    const publicBase = request.headers.get("X-King-AI-Public-Base") || new URL(request.url).origin;
    const remoteAssist = activeRemoteAssistGrant(state);
    const isRemoteAssist = Boolean(new URL(request.url).searchParams.get("assist") || request.headers.get("X-King-AI-Assist-Token"));
    const requestedConversationId = new URL(request.url).searchParams.get("conversationId") || DEFAULT_CONVERSATION.id;
    const activeConversation = state.conversations.find((row) => row.id === requestedConversationId) ?? state.conversations.find((row) => row.id === DEFAULT_CONVERSATION.id);
    const activeAgents = teamAgentsFor(state, activeConversation);
    return json({
      connection: {
        paired,
        online,
        computerId: state.computerId,
        lastHeartbeatAt,
        version: state.lastHeartbeat?.version
      },
      tenantId,
      remoteAssist: remoteAssist ? remoteAssistSummary(remoteAssist) : { active: false },
      access: { remoteAssist: isRemoteAssist },
      currentUser: authUserFromRequest(request),
      pairingCode: isRemoteAssist ? undefined : encodedPairingCode,
      pairingLocator: isRemoteAssist ? undefined : pairingLocator({ serverUrl: publicBase, tenantId, code: state.pairingCode }),
      rawPairingCode: isRemoteAssist ? undefined : state.pairingCode,
      pairCommandTenantArg: "",
      conversations: conversationSummaries(state),
      workflows: workflowSummaries(state),
      availableEngines: state.availableEngines,
      capabilities: state.capabilities,
      agent: agentSummary,
      agents: state.agents.map((row) => agentStateSummary(state, row)),
      activeConversation,
      activeAgents: activeAgents.map((row) => agentStateSummary(state, row)),
      actualEngine: runtimeBodyEngine(lastRunStart?.body) ?? agent.engine ?? "not running yet",
      observation,
      routeSummary: formatMessageRouteSummary(unread, DEFAULT_AGENT.id),
      agentConfigUpdatedAt: state.agentConfigUpdatedAt,
      lastRun: {
        start: lastRunStart,
        finish: lastRunFinish
      }
    });
  }

  private async guiActivity(params: URLSearchParams): Promise<Response> {
    const state = await this.get();
    const limit = Math.min(100, Math.max(1, Number.parseInt(params.get("limit") || "40", 10) || 40));
    const rows = [
      ...state.messages.map((message) => ({
        type: `message.${message.author_kind}`,
        at: message.created_at,
        summary: `${message.author_name}: ${message.body}`,
        body: message
      })),
      ...state.statusLog.map((row) => ({
        type: "runtime.status",
        at: row.at,
        summary: row.status,
        body: row
      })),
      ...state.typingLog.map((row) => ({
        type: row.done ? "typing.done" : "typing.start",
        at: row.at,
        summary: row.conversationId || "conversation",
        body: row
      })),
      ...state.thinkingLog.map((row) => ({
        type: `thinking.${row.action}`,
        at: row.at,
        summary: row.conversationIds.join(", ") || "conversation",
        body: row
      })),
      ...state.runLog.map((row) => ({
        type: `run.${row.action}`,
        at: row.at,
        summary: `${row.runId}${runtimeBodyStatus(row.body) ? ` ${runtimeBodyStatus(row.body)}` : ""}`,
        body: row
      })),
      ...state.cliLog.map((row) => ({
        type: "runtime.cli",
        at: row.at,
        summary: `${row.argv.join(" ")} -> ${row.result}`,
        body: row
      })),
      ...state.noticeLog.map((row) => ({
        type: "runtime.notice",
        at: row.at,
        summary: formatNoticeSummary(row.body),
        body: row
      })),
      ...state.triageLog.map((row) => ({
        type: "runtime.triage",
        at: row.at,
        summary: summarizeUnknown(row.body),
        body: row
      })),
      ...state.loopEvents.map((row) => ({
        type: row.type,
        at: Date.parse(row.timestamp) || Date.now(),
        summary: formatLoopEventLine(row),
        body: row
      }))
    ].sort((a, b) => b.at - a.at).slice(0, limit);
    return json({ rows });
  }

  private async authDevice(request: Request, fn: () => Promise<Response>): Promise<Response> {
    const state = await this.get();
    if (token(request) !== state.deviceToken) return json({ error: "invalid device token" }, { status: 401 });
    return fn();
  }

  private async authRuntime(request: Request, fn: (agentId: string) => Promise<Response>): Promise<Response> {
    const state = await this.get();
    const agentId = agentIdForRuntimeToken(state, token(request));
    if (!agentId) return json({ error: "invalid runtime token" }, { status: 401 });
    return fn(agentId);
  }

  private async wakeStream(agentId: string): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const waiter = { agentId, writer };
    this.waiters.add(waiter);
    void writer.write(encode(": connected\n\n")).catch(() => this.waiters.delete(waiter));
    requestKeepAlive(writer, () => this.waiters.delete(waiter));
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  // Server-sent events for the browser GUI: it gets a generic "change" nudge on every broadcast so
  // it can refresh immediately instead of polling. Authentication is enforced by the worker route.
  private async guiEvents(): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const waiter = { agentId: "", gui: true, writer };
    this.waiters.add(waiter);
    void writer.write(encode(": connected\n\n")).catch(() => this.waiters.delete(waiter));
    requestKeepAlive(writer, () => this.waiters.delete(waiter));
    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  private async inbox(agentId: string): Promise<Response> {
    const state = await this.get();
    const unread = unreadMessagesFor(state, agentId);
    return json({
      rows: sortRuntimeMessages(unread, agentId).map((item) => item.row),
      routeSummary: formatMessageRouteSummary(unread, agentId)
    });
  }

  private async triage(agentId: string): Promise<Response> {
    const state = await this.get();
    const unread = unreadMessagesFor(state, agentId);
    const routed = sortRuntimeMessages(unread, agentId);
    const top = routed[0];
    const replyConversationId = top?.row.conversation_id || DEFAULT_CONVERSATION.id;
    return json({
      instructions: "Return strict JSON: {\"actionable\": boolean, \"reason\": string, \"promptNote\": string, \"routeHint\": \"ignore|monitor|respond|steer\", \"priority\": \"normal|steer|urgent\"}. Mark human messages actionable and prioritize blocker, approval, decision, direct, and @mention messages.",
      input: routed.map((item) => `${messageRouteTag(item)} score=${item.score} ${item.row.author_name}: ${item.row.body}`).join("\n"),
      routeSummary: formatMessageRouteSummary(unread, agentId),
      verdict: unread.length ? {
        actionable: top ? top.route !== "ignore" : true,
        reason: top ? `gui unread message routed ${messageRouteTag(top)}` : "gui unread message",
        promptNote: `Handle the highest-priority routed message first. Reply through king-ai reply ${replyConversationId} --file notes/reply.md or a short inline reply.`,
        routeHint: top?.route,
        priority: top?.priority
      } : { actionable: false, reason: "inbox empty", routeHint: "ignore", priority: "normal" }
    });
  }

  private async roster(): Promise<Response> {
    const state = await this.get();
    const agentStates = state.agents.map((agent) => agentStateSummary(state, agent));
    return json({
      roster: agentStates.map(formatRosterAgent).join("\n"),
      agentStates,
      agents: state.agents
    });
  }

  private async preamble(params: URLSearchParams): Promise<Response> {
    const state = await this.get();
    return json({
      text: buildRuntimePreamble(state, {
        agentId: params.get("agent") || DEFAULT_AGENT.id,
        reason: params.get("reason") || "wake",
        runId: params.get("runId") || undefined,
        steerReason: params.get("steerReason") || undefined
      })
    });
  }

  private async agenda(agentId: string): Promise<Response> {
    const state = await this.get();
    const now = new Date();
    const due = state.calendar.filter((item) =>
      item.assignee === agentId &&
      (Date.parse(item.at) <= now.getTime() || (item.cron ? cronMatches(item.cron, now) : false))
    );
    const card = state.cards.find((row) => row.column !== "done" && (!row.assignee || row.assignee === agentId));
    const task = state.tasks.find((row) => taskVisibleStatus(state, row) !== "done" && taskVisibleStatus(state, row) !== "blocked" && (!row.assignee || row.assignee === agentId));
    if (!due.length && !card && !task) return json({ actionable: false });
    const lines = [
      ...due.map((item) => `Calendar due: ${item.title}${item.cron ? ` [cron ${item.cron}]` : ""}${item.prompt ? ` — ${item.prompt}` : ""}`),
      ...(card ? [`Board card: ${card.id} [${card.column}] ${card.title}`] : []),
      ...(task ? [`Task: ${task.id} [${task.status}] ${task.title}`] : [])
    ];
    return json({
      actionable: true,
      focus: task?.id ?? card?.id ?? due[0]?.id,
      brief: lines.join("\n")
    } satisfies AgendaPayload);
  }

  private async cli(payload: { argv?: string[]; agentId?: string; tokenAgentId?: string; engine?: string; runId?: string; contract?: unknown; authUser?: AuthUser }): Promise<Response> {
    const argv = payload.argv ?? [];
    const state = await this.get();
    const actor = findAgent(state, payload.agentId) ?? findAgent(state, payload.tokenAgentId) ?? defaultAgentFor(state);
    const authorEngine = activeRunEngine(state) ?? normalizeEngineId(payload.engine) ?? actor.engine ?? DEFAULT_AGENT.engine ?? "codex";
    const runContract = resolveRunContract(state, payload.runId, payload.contract);
    const outcome = await dispatchRuntimeCli({
      argv,
      state,
      actor,
      authorEngine,
      runContract,
      payload
    }, {
      defaultAgentId: DEFAULT_AGENT.id,
      findConversation,
      validateRunContractAction: (currentState, contract, currentActor, action) => {
        if (action.command !== "reply" && action.command !== "task") return undefined;
        return validateRunContractAction(currentState, contract as RunContract | undefined, currentActor, {
          command: action.command,
          conversationId: action.conversationId,
          taskId: action.taskId
        }) ?? undefined;
      },
      unreadMessagesFor,
      isRuntimeVisibleMessage: (message) => isRuntimeVisibleMessage(message as Message),
      pendingBelongsToAgent: (message, currentActor) => pendingBelongsToAgent(message as Message, currentActor),
      recordRunAction: (currentState, runId, contract, currentActor, action, detail) => {
        if (action !== "reply" && action !== "task" && action !== "ignore") return;
        recordRunAction(currentState, runId, contract as RunContract | undefined, currentActor, action, detail);
      },
      agentStateSummary,
      formatRosterAgent: (summary) => formatRosterAgent(summary as AgentStateSummary),
      buildRuntimePreamble,
      readOption,
      displayNameForHuman: (currentState, user) => displayNameForHuman(currentState, user ? { id: user.email ?? user.name ?? "gui-human", ...user } : undefined),
      isTaskMutationCommand,
      isCliUsageOrError,
      stateCommand: (currentState, commandArgs) => this.stateCommand(currentState, commandArgs),
      agentsCommand: (currentState, commandArgs) => this.agentsCommand(currentState, commandArgs),
      observeCommand: (currentState, commandArgs) => this.observeCommand(currentState, commandArgs),
      loopCommand: (currentState, commandArgs) => this.loopCommand(currentState, commandArgs),
      cardCommand: (currentState, commandArgs) => this.cardCommand(currentState, commandArgs),
      taskCommand: (currentState, commandArgs, currentActor) => this.taskCommand(currentState, commandArgs, currentActor),
      initiativeCommand: (currentState, commandArgs) => this.initiativeCommand(currentState, commandArgs),
      capsuleCommand: (currentState, commandArgs) => this.capsuleCommand(currentState, commandArgs),
      mergeCommand: (currentState, commandArgs) => this.mergeCommand(currentState, commandArgs),
      evalCommand: (currentState, commandArgs) => this.evalCommand(currentState, commandArgs),
      feedbackCommand: (currentState, commandArgs) => this.feedbackCommand(currentState, commandArgs),
      reviewCommand: (currentState, commandArgs) => this.reviewCommand(currentState, commandArgs),
      routeCommand: (currentState, commandArgs) => this.routeCommand(currentState, commandArgs),
      calendarCommand: (currentState, commandArgs) => this.calendarCommand(currentState, commandArgs),
      claimCommand: (currentState, commandArgs, currentActor) => this.claimCommand(currentState, commandArgs, currentActor),
      unclaimCommand: (currentState, commandArgs) => this.unclaimCommand(currentState, commandArgs),
      dmCommand: (currentState, commandArgs, currentActor) => this.dmCommand(currentState, commandArgs, currentActor),
      reactCommand: (currentState, commandArgs, currentActor) => this.reactCommand(currentState, commandArgs, currentActor),
      docCommand: (currentState, commandArgs) => this.docCommand(currentState, commandArgs),
      artifactCommand: (currentState, commandArgs, currentActor) => this.artifactCommand(currentState, commandArgs, currentActor),
      contextCommand: (currentState, commandArgs, currentActor) => this.contextCommand(currentState, commandArgs, currentActor),
      hypothesisCommand: (currentState, commandArgs, currentActor) => this.hypothesisCommand(currentState, commandArgs, currentActor),
      planCommand: (currentState, commandArgs) => this.planCommand(currentState, commandArgs),
      safetyCommand: (currentState, commandArgs) => this.safetyCommand(currentState, commandArgs),
      sendCommand: (currentState, commandArgs, currentActor) => this.sendCommand(currentState, commandArgs, currentActor),
      recvCommand: (currentState, commandArgs) => this.recvCommand(currentState, commandArgs),
      recallCommand: (commandArgs) => runRecallCommand(this.episodicSql(), commandArgs),
      escalateCommand: (currentState, commandArgs, currentActor) => this.escalateCommand(currentState, commandArgs, currentActor),
      agendaJson: async (agentId) => (await this.agenda(agentId).then((res) => res.json())) as AgendaPayload,
      getStateField: {
        messages: (currentState) => currentState.messages,
        pushMessage: (currentState, message) => { currentState.messages.push(message as Message); },
        agents: (currentState) => currentState.agents,
        composing: (currentState) => currentState.composing,
        setComposing: (currentState, composing) => {
          currentState.composing = composing.map((claim) => ({
            ...claim,
            agentId: currentState.composing.find((row) =>
              row.conversationId === claim.conversationId &&
              row.agentName === claim.agentName &&
              row.claimed_at === claim.claimed_at
            )?.agentId ?? claim.agentName
          }));
        },
        claims: (currentState) => currentState.claims.filter((claim): claim is Claim & { conversationId: string } => typeof claim.conversationId === "string"),
        statusLog: (currentState) => currentState.statusLog,
        availableEngines: (currentState) => currentState.availableEngines
      },
      actorField: {
        id: (currentActor) => currentActor.id,
        name: (currentActor) => currentActor.name,
        engine: (currentActor) => currentActor.engine,
        json: (currentActor) => currentActor
      }
    });
    if (outcome.kind === "reject") return this.cliRejected(state, actor, argv, outcome.result);
    state.cliLog.push({ at: Date.now(), agentId: actor.id, argv, result: outcome.result });
    await this.put(state);
    return json({ exitCode: 0, text: outcome.result });
  }

  private async cliRejected(state: State, actor: Agent, argv: string[], result: string): Promise<Response> {
    state.cliLog.push({ at: Date.now(), agentId: actor.id, argv, result });
    await this.put(state);
    return json({ exitCode: 64, text: result });
  }

  private cardCommand(state: State, args: string[]): string {
    return runCardCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      createCard: (currentState, title, allowedPaths) => this.newCard(currentState, title, undefined, allowedPaths),
      pathConflict,
      parseAllowedPaths,
      stripOptions,
      readOption
    });
  }

  private async stateCommand(state: State, args: string[]): Promise<string> {
    return await runStateCommand(state, args, {
      snapshot: (currentState) => this.snapshot(currentState),
      importSnapshot: (payload) => this.importSnapshot(payload),
      resetState: () => this.resetState()
    });
  }

  private agentsCommand(state: State, args: string[]): string {
    return runAgentsCommand(state, args, {
      agentStateSummary,
      formatAgentMatrixLine: (agent) => formatAgentMatrixLine(agent as AgentStateSummary)
    });
  }

  private observeCommand(state: State, args: string[]): string {
    return runObserveCommand(state, args, {
      buildLoopSnapshot,
      readOption
    });
  }

  private loopCommand(state: State, args: string[]): string {
    return runLoopCommand(state, args, {
      readOption,
      parseCsvOption,
      readNumberOption,
      parseEventPayload,
      normalizePositiveInt,
      isLoopEventType,
      pushLoopEvent: (currentState, event) => pushLoopEvent(currentState, event as Omit<LoopEvent, "runId" | "loop" | "timestamp"> & Partial<Pick<LoopEvent, "runId" | "loop" | "timestamp">>),
      buildEventLoopSnapshot,
      formatLoopEventLine: (event) => formatLoopEventLine(event as LoopEvent)
    });
  }

  private taskCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runTaskCommand(state, args, actor, {
      lookupTask,
      formatTaskLine,
      taskScopeConflicts,
      taskScopeFromArgs,
      parseCsvOption,
      readOption,
      stripOptions,
      normalizePriority,
      isTaskStatus,
      applyTaskReviewPayload,
      pushLoopEvent: (currentState, event) => pushLoopEvent(currentState, event as Omit<LoopEvent, "runId" | "loop" | "timestamp"> & Partial<Pick<LoopEvent, "runId" | "loop" | "timestamp">>),
      ensureConversation,
      workerAgentForConversation: (currentState, conversation) => workerAgentForConversation(currentState, ensureConversation(currentState, conversation.id)),
      defaultWorkerAgentFor,
      pushTaskTransition,
      queueTaskChangesRequestedMessage,
      advanceTaskDone
    });
  }

  private initiativeCommand(state: State, args: string[]): string {
    return runInitiativeCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      findInitiative,
      formatInitiativeLine,
      readOption,
      stripOptions,
      parseCsvOption,
      normalizePriority,
      isInitiativeStatus
    });
  }

  private capsuleCommand(state: State, args: string[]): string {
    return runCapsuleCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      findCapsule,
      formatCapsuleLine,
      capsuleConflicts,
      parseAllowedPaths,
      readOption,
      stripOptions,
      parseCsvOption,
      isCapsuleStatus,
      isCapsuleScopeType
    });
  }

  private mergeCommand(state: State, args: string[]): string {
    return runMergeCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      findMergeRequest,
      findCapsule,
      lookupTask,
      formatMergeRequestLine,
      readOption,
      isSafeBranchName,
      isMergeStatus
    });
  }

  private evalCommand(state: State, args: string[]): string {
    return runEvalCommand(state, args, {
      findEvaluation,
      formatEvaluationLine,
      formatEvaluationSummary,
      firstJsonArg,
      parseEvaluationRecord,
      readOption
    });
  }

  private feedbackCommand(state: State, args: string[]): string {
    return runFeedbackCommand(state, args, {
      findRunFeedback,
      formatRunFeedbackLine,
      formatRunFeedbackSummaryLine: (summary) => formatRunFeedbackSummaryLine(summary as RunFeedbackSummary),
      summarizeRunFeedback,
      parseRunFeedback,
      readOption,
      readBooleanOption
    });
  }

  private reviewCommand(state: State, args: string[]): string {
    return runReviewCommand(state, args, {
      findReview,
      findCapsule,
      findMergeRequest,
      parseReviewRecord: (commandArgs, capsule) => parseReviewRecord(commandArgs, capsule as ChangeCapsule),
      formatReviewLine,
      readOption
    });
  }

  private routeCommand(state: State, args: string[]): string {
    return runRouteCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      ensureRouteAgent: (currentState, agentId) => {
        if (!currentState.agents.some((agent) => agent.id === agentId)) {
          currentState.agents.push({ ...DEFAULT_AGENT, id: agentId, name: agentId, role: "Event subscriber" });
        }
      },
      formatEventRouteLine,
      readOption,
      parseExternalEventArgs,
      routeExternalEvent: (currentState, event) => routeExternalEvent(currentState, event as ExternalEvent),
      pushLoopEvent: (currentState, event) => { pushLoopEvent(currentState, event as Omit<LoopEvent, "runId" | "loop" | "timestamp"> & Partial<Pick<LoopEvent, "runId" | "loop" | "timestamp">>); },
      countPendingMessages
    });
  }

  private calendarCommand(state: State, args: string[]): string {
    return runCalendarCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      readOption,
      parseCron
    });
  }

  private claimCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runClaimCommand(state, args, actor, {
      parseAllowedPaths,
      readOption,
      pathConflict
    });
  }

  private unclaimCommand(state: State, args: string[]): string {
    return runUnclaimCommand(state, args);
  }

  private dmCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runDmCommand(state, args, actor, {
      defaultAgentId: DEFAULT_AGENT.id,
      newAgentMessage: (input) => this.newAgentMessage({
        ...input,
        fromKind: input.fromKind as Message["author_kind"],
        fromEngine: input.fromEngine as Agent["engine"]
      }) as Message,
      resolveEscalationTarget: (currentState) => currentState.agents.find((agent) => agent.id === "ceo" || agent.name.toLowerCase().includes("ceo"))?.id ?? DEFAULT_AGENT.id,
      readOption,
      stripOptions,
      isRuntimeVisibleMessage: (message) => isRuntimeVisibleMessage(message as Message),
      sortRuntimeMessages: (messages, agentId) => sortRuntimeMessages(messages as Message[], agentId),
      messageRouteTag: (routed) => messageRouteTag(routed as unknown as Parameters<typeof messageRouteTag>[0])
    });
  }

  private sendCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runSendCommand(state, args, actor, {
      defaultAgentId: DEFAULT_AGENT.id,
      newAgentMessage: (input) => this.newAgentMessage({
        ...input,
        fromKind: input.fromKind as Message["author_kind"],
        fromEngine: input.fromEngine as Agent["engine"]
      }) as Message,
      resolveEscalationTarget: (currentState) => currentState.agents.find((agent) => agent.id === "ceo" || agent.name.toLowerCase().includes("ceo"))?.id ?? DEFAULT_AGENT.id,
      readOption,
      stripOptions,
      isRuntimeVisibleMessage: (message) => isRuntimeVisibleMessage(message as Message),
      sortRuntimeMessages: (messages, agentId) => sortRuntimeMessages(messages as Message[], agentId),
      messageRouteTag: (routed) => messageRouteTag(routed as unknown as Parameters<typeof messageRouteTag>[0])
    });
  }

  private recvCommand(state: State, args: string[]): string {
    return runRecvCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      newAgentMessage: (input) => this.newAgentMessage({
        ...input,
        fromKind: input.fromKind as Message["author_kind"],
        fromEngine: input.fromEngine as Agent["engine"]
      }) as Message,
      resolveEscalationTarget: (currentState) => currentState.agents.find((agent) => agent.id === "ceo" || agent.name.toLowerCase().includes("ceo"))?.id ?? DEFAULT_AGENT.id,
      readOption,
      stripOptions,
      isRuntimeVisibleMessage: (message) => isRuntimeVisibleMessage(message as Message),
      sortRuntimeMessages: (messages, agentId) => sortRuntimeMessages(messages as Message[], agentId),
      messageRouteTag: (routed) => messageRouteTag(routed as unknown as Parameters<typeof messageRouteTag>[0])
    });
  }

  private escalateCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runEscalateCommand(state, args, actor, {
      defaultAgentId: DEFAULT_AGENT.id,
      newAgentMessage: (input) => this.newAgentMessage({
        ...input,
        fromKind: input.fromKind as Message["author_kind"],
        fromEngine: input.fromEngine as Agent["engine"]
      }) as Message,
      resolveEscalationTarget: (currentState) => currentState.agents.find((agent) => agent.id === "ceo" || agent.name.toLowerCase().includes("ceo"))?.id ?? DEFAULT_AGENT.id,
      readOption,
      stripOptions,
      isRuntimeVisibleMessage: (message) => isRuntimeVisibleMessage(message as Message),
      sortRuntimeMessages: (messages, agentId) => sortRuntimeMessages(messages as Message[], agentId),
      messageRouteTag: (routed) => messageRouteTag(routed as unknown as Parameters<typeof messageRouteTag>[0])
    });
  }

  private reactCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runReactCommand(state, args, actor);
  }

  private docCommand(state: State, args: string[]): string {
    return runDocCommand(state, args);
  }

  private artifactCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runArtifactCommand(state, args, actor, {
      readOption,
      standardArtifactKinds: STANDARD_ARTIFACT_KINDS,
      findArtifact: (currentState, id) => findArtifactInState(currentState, id) as Artifact | undefined,
      artifactCandidateFromArgs: (artifactArgs) => artifactCandidateFromArgsHelper(artifactArgs, readOption),
      checkArtifactQuality: checkArtifactQualityHelper,
      formatArtifactQualityCheck: formatArtifactQualityCheckHelper,
      parseMetadataJson: parseMetadataJsonHelper,
      formatArtifactLine: formatArtifactLineHelper,
      pushLoopEvent: (currentState, event) => pushLoopEvent(currentState, event as Omit<LoopEvent, "runId" | "loop" | "timestamp"> & Partial<Pick<LoopEvent, "runId" | "loop" | "timestamp">>)
    });
  }

  private contextCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runContextCommand(state, args, actor, {
      readOption,
      stripOptions
    });
  }

  private hypothesisCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    return runHypothesisCommand(state, args, actor, {
      readOption,
      stripOptions,
      parseCsvOption,
      isHypothesisStatus,
      findHypothesis,
      formatHypothesisLine
    });
  }

  private planCommand(state: State, args: string[]): string {
    return runPlanCommand(state, args, {
      defaultAgentId: DEFAULT_AGENT.id,
      parseExecutionPlan,
      readOption,
      createTask: (input) => workflowCreateGuiTaskDraft(input) as Task
    });
  }

  private safetyCommand(state: State, args: string[]): string {
    return runSafetyCommand(state, args, {
      safetyActions: Array.from(SAFETY_ACTIONS),
      isSafetyAction,
      safetyCheck: (action) => safetyCheck(action as SafetyAction),
      parseSafetyContext,
      stringContextValue,
      findApproval,
      formatApprovalLine,
      readOption,
      stripOptions
    });
  }

  private async resolveApproval(approvalId: string, payload: { decision?: string; reason?: string }): Promise<Response> {
    const state = await this.get();
    const request = findApproval(state, approvalId);
    if (!request) return json({ error: `approval not found: ${approvalId || ""}` }, { status: 404 });
    if (request.status !== "pending") return json({ error: `cannot resolve ${request.id}: status=${request.status}` }, { status: 409 });
    const decision = payload.decision === "approve" || payload.decision === "approved"
      ? "approved"
      : payload.decision === "deny" || payload.decision === "denied"
        ? "denied"
        : undefined;
    if (!decision) return json({ error: "decision must be approve or deny" }, { status: 400 });
    request.status = decision;
    request.resolvedAt = Date.now();
    if (decision === "denied") {
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
      request.reason = reason || "denied";
    }
    await this.put(state);
    return json({ ok: true, approval: request });
  }

  private async status(payload: { status?: string }, agentId = DEFAULT_AGENT.id): Promise<Response> {
    const state = await this.get();
    state.statusLog.push({ at: Date.now(), status: payload.status || "unknown", agentId });
    await this.put(state);
    return json({ ok: true });
  }

  private async typing(payload: { conversationId?: string; done?: boolean }, agentId = DEFAULT_AGENT.id): Promise<Response> {
    const state = await this.get();
    state.typingLog.push({ at: Date.now(), conversationId: payload.conversationId, done: payload.done });
    if (!payload.done) state.composing.push({
      conversationId: payload.conversationId || DEFAULT_CONVERSATION.id,
      agentId,
      agentName: findAgent(state, agentId)?.name ?? agentId,
      claimed_at: Date.now(),
      expires_at: Date.now() + 60_000
    });
    await this.put(state);
    return json({ ok: true });
  }

  private async thinking(action: "mark" | "unmark", payload: { conversationIds?: string[] }, agentId = DEFAULT_AGENT.id): Promise<Response> {
    const state = await this.get();
    const now = Date.now();
    const ids = Array.isArray(payload.conversationIds) ? payload.conversationIds.filter((id): id is string => typeof id === "string") : [];
    state.thinkingLog.push({
      at: now,
      action,
      conversationIds: ids
    });
    state.composing = state.composing.filter((claim) => claim.expires_at > now && !(ids.includes(claim.conversationId) && claim.agentId === agentId));
    if (action === "mark") {
      const agent = findAgent(state, agentId) ?? defaultAgentFor(state);
      for (const conversationId of ids) {
        state.composing.push({
          conversationId,
          agentId,
          agentName: agent.name,
          claimed_at: now,
          expires_at: now + 60_000
        });
      }
    }
    await this.put(state);
    return json({ ok: true });
  }

  private async events(body: unknown): Promise<Response> {
    const state = await this.get();
    state.eventLog.push({ at: Date.now(), body });
    const event = normalizeExternalEvent(body);
    const routed = event ? routeExternalEvent(state, event) : [];
    for (const agentId of routed) {
      pushLoopEvent(state, {
        type: "queue.backlog",
        agent: agentId,
        pendingMessages: countPendingMessages(state, agentId),
        payload: event
      });
    }
    await this.put(state);
    return json({ ok: true, routed });
  }

  private async logBody(key: "noticeLog" | "triageLog", body: unknown): Promise<Response> {
    const state = await this.get();
    state[key].push({ at: Date.now(), body });
    await this.put(state);
    return json({ ok: true });
  }

  private async startRun(body: unknown): Promise<Response> {
    const state = await this.get();
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const contract = normalizeRunContract(body && typeof body === "object" ? (body as { contract?: unknown }).contract : undefined);
    state.loopRunId = runId;
    state.runStreams = pruneRunStreams({ ...(state.runStreams ?? {}), [runId]: initialRunStreamState() });
    if (contract) state.activeRunContracts = pruneActiveRunContracts({ ...(state.activeRunContracts ?? {}), [runId]: contract });
    state.runLog.push({ at: Date.now(), runId, action: "start", body });
    await this.put(state);
    return json({ runId, contract });
  }

  private async runAction(runId: string, action: "heartbeat" | "finish", body?: unknown): Promise<Response> {
    const state = await this.get();
    const streamEvent = normalizeRunStreamEvent(body);
    if (streamEvent) {
      const current = state.runStreams?.[runId] ?? initialRunStreamState();
      state.runStreams = pruneRunStreams({ ...(state.runStreams ?? {}), [runId]: reduceRunStream(current, streamEvent) });
      state.runLog.push({ at: Date.now(), runId, action: "stream", body: streamEvent, card: renderRunStreamCard(state.runStreams[runId]) });
    }
    if (action === "finish") {
      const current = state.runStreams?.[runId] ?? initialRunStreamState();
      const terminal = body && typeof body === "object" && (body as { status?: unknown }).status === "failed"
        ? reduceRunStream(current, { type: "error", message: typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "run failed" })
        : reduceRunStream(current, { type: "done" });
      state.runStreams = pruneRunStreams({ ...(state.runStreams ?? {}), [runId]: terminal });
      if (state.activeRunContracts?.[runId]) {
        state.activeRunContracts = { ...state.activeRunContracts };
        delete state.activeRunContracts[runId];
      }
      state.runLog.push({ at: Date.now(), runId, action, body, card: renderRunStreamCard(terminal) });
    } else {
      state.runLog.push({ at: Date.now(), runId, action, body, card: state.runStreams?.[runId] ? renderRunStreamCard(state.runStreams[runId]) : undefined });
    }
    await this.put(state);
    return json({ ok: true, runId });
  }

  private async runActions(runId: string, agentId: string): Promise<Response> {
    const state = await this.get();
    const rows = (state.runActions?.[runId] ?? []).filter((row) => row.agentId === agentId);
    return json({ runId, actions: rows });
  }

  private async markRead(payload: { conversationId?: string; upToMessageId?: string }, agentId = DEFAULT_AGENT.id): Promise<Response> {
    const state = await this.get();
    const conversationMessages = state.messages.filter((m) => m.conversation_id === payload.conversationId);
    const cutoffIndex = conversationMessages.findIndex((m) => m.id === payload.upToMessageId);
    const readable = cutoffIndex >= 0 ? conversationMessages.slice(0, cutoffIndex + 1) : conversationMessages;
    for (const message of readable) {
      if (
        !message.readBy.includes(agentId)
      ) {
        message.readBy.push(agentId);
      }
    }
    await this.put(state);
    return json({ ok: true });
  }

  private async guiConversation(payload: GuiConversationPayload): Promise<Response> {
    const state = await this.get();
    const now = Date.now();
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : `事务 ${state.conversations.length + 1}`;
    const maxOrder = Math.max(0, ...state.conversations.map((conversation) => conversation.order ?? 0));
    const order = Math.max(maxOrder + 1, now * 1000);
    const team = normalizeConversationTeam(state, { ...payload, workflowId: payload.workflowId ?? DEFAULT_NEW_CONVERSATION_WORKFLOW_ID });
    const roleOverrides = normalizeAgentRolePayload(payload.agentRoles);
    const teamSnapshot = buildConversationTeamSnapshot(state, team, roleOverrides, now);
    const conversation: Conversation = {
      id: `convo-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      kind: "group",
      created_at: now,
      updated_at: now,
      order,
      workflowId: team.workflowId,
      teamMode: team.teamMode,
      coordinatorAgentId: team.coordinatorAgentId,
      teamAgentIds: team.teamAgentIds,
      teamSnapshot
    };
    state.conversations.push(conversation);
    await this.put(state);
    return json({ ok: true, conversation });
  }

  private async guiUpdateConversationTeam(conversationId: string | undefined, payload: GuiConversationPayload): Promise<Response> {
    const state = await this.get();
    const conversation = state.conversations.find((row) => row.id === conversationId);
    if (!conversation) return json({ error: `conversation not found: ${conversationId || ""}` }, { status: 404 });
    return json({ error: "conversation team is immutable after creation" }, { status: 409 });
  }

  private async guiUpdateWorkflowAgents(workflowIdValue: string | undefined, payload: GuiWorkflowAgentsPayload): Promise<Response> {
    const state = await this.get();
    const workflow = workflowTemplateByIdOrUndefined(workflowIdValue);
    if (!workflow) return json({ error: `workflow not found: ${workflowIdValue || ""}` }, { status: 404 });
    const incomingAgents = normalizeWorkflowAgentDefinitions(payload.agents);
    if (incomingAgents.length) state.agents = upsertAgents(state.agents, incomingAgents);
    state.workflowAgentIds = normalizeWorkflowAgentIds(state.workflowAgentIds, state.agents);
    const requestedIds = normalizeStringList(payload.agentIds).map(normalizeAgentId).filter((id): id is string => Boolean(id));
    const candidateIds = requestedIds.length ? requestedIds : state.workflowAgentIds[workflow.id] ?? workflow.agentIds;
    const validIds = [...new Set(candidateIds)].filter((id) => Boolean(findAgent(state, id)));
    if (!validIds.includes(workflow.defaultCoordinatorAgentId) && findAgent(state, workflow.defaultCoordinatorAgentId)) validIds.unshift(workflow.defaultCoordinatorAgentId);
    state.workflowAgentIds[workflow.id] = validIds.length ? validIds : workflow.agentIds;
    state.agentConfigUpdatedAt = Date.now();
    await this.put(state);
    return json({ ok: true, workflow: workflowSummary(state, workflow) });
  }

  private async guiDeleteConversation(conversationId?: string): Promise<Response> {
    if (!conversationId || conversationId === DEFAULT_CONVERSATION.id) return json({ error: "default conversation cannot be deleted" }, { status: 400 });
    const state = await this.get();
    const before = state.conversations.length;
    state.conversations = state.conversations.filter((conversation) => conversation.id !== conversationId);
    state.messages = state.messages.filter((message) => message.conversation_id !== conversationId);
    await this.put(state);
    return json({ ok: true, deleted: before !== state.conversations.length });
  }

  private async guiMessage(request: Request, payload: { body?: string; conversationId?: string; attachments?: unknown }): Promise<Response> {
    const state = await this.get();
    const conversation = ensureConversation(state, payload.conversationId || DEFAULT_CONVERSATION.id);
	    const now = Date.now();
	    const targetAgent = coordinatorAgentFor(state, conversation);
	    const humanName = displayNameForAuthUser(authUserFromRequest(request));
	    const attachments = normalizeRuntimeAttachments(payload.attachments).map((attachment) => {
	      if (attachment.url || !attachment.id) return attachment;
	      const upload = state.uploads?.[attachment.id];
	      if (!upload) return attachment;
	      const base = request.headers.get("X-King-AI-Public-Base") || new URL(request.url).origin;
	      const tenantId = tenantHeader(request);
	      return { ...attachment, url: `${base}/gui/attachments/${encodeURIComponent(upload.id)}?token=${encodeURIComponent(upload.token)}&tenant=${encodeURIComponent(tenantId)}` };
	    });
	    const message: Message = {
      id: `msg-${now}`,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      conversation_kind: conversation.kind,
      author_name: humanName,
	      author_kind: "human",
	      kind: "message",
	      body: payload.body || "Hello from the local gui runtime.",
	      attachments: normalizeRuntimeAttachments(attachments),
	      to_agent_id: targetAgent.id,
      created_at: now,
      readBy: []
    };
    const pendingReply: Message = {
      id: `msg-${now}-pending`,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      conversation_kind: conversation.kind,
      author_name: targetAgent.name,
      author_kind: "agent",
      author_engine: targetAgent.engine,
      status: "pending",
      kind: "message",
      body: "AI 正在处理...",
      to_agent_id: targetAgent.id,
      created_at: now + 1,
      readBy: [targetAgent.id]
    };
    state.messages = state.messages.filter((row) => !(
      row.conversation_id === conversation.id &&
      row.status === "pending" &&
      pendingBelongsToAgent(row, targetAgent)
    ));
    conversation.updated_at = now;
    state.messages.push(message);
    state.messages.push(pendingReply);
    autoDelegateMessage(state, conversation, message, targetAgent);
    const delegated = state.tasks.find((task) => task.requestMessageId === message.id);
    if (delegated?.assignee && delegated.assignee !== targetAgent.id) updatePendingForTask(state, delegated, `已委派给 ${delegated.assignee} 处理...`);
    await this.put(state);
    await this.broadcast({ event: "wake", data: { conversationId: message.conversation_id, requestId: message.id, messageId: message.id, taskId: delegated?.id, agentId: targetAgent.id, at: now } });
    if (delegated?.assignee) {
      await this.broadcast({ event: "wake", data: { agenda: true, conversationId: conversation.id, requestId: message.id, messageId: message.id, taskId: delegated.id, agentId: delegated.assignee, at: Date.now() } });
	    }
	    return json({ ok: true, message });
	  }

	  private async guiAttachment(request: Request, payload: unknown): Promise<Response> {
	    const row = payload && typeof payload === "object" ? payload as { name?: unknown; mime?: unknown; size?: unknown; bytesBase64?: unknown } : {};
	    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim().slice(0, 240) : "attachment";
	    const mime = typeof row.mime === "string" && row.mime.trim() ? row.mime.trim().toLowerCase().slice(0, 120) : "application/octet-stream";
	    const bytesBase64 = typeof row.bytesBase64 === "string" ? row.bytesBase64 : "";
	    const actualSize = approximateBase64Bytes(bytesBase64);
	    const size = Number.isFinite(row.size) && Number(row.size) >= 0 ? Math.floor(Number(row.size)) : actualSize;
	    if (!bytesBase64) return json({ error: "missing attachment bytes" }, { status: 400 });
	    if (size > GUI_ATTACHMENT_MAX_BYTES || actualSize > GUI_ATTACHMENT_MAX_BYTES) return json({ error: "attachment too large" }, { status: 413 });
	    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	    const token = crypto.randomUUID();
	    const chunkCount = await this.writeUploadBytes(id, bytesBase64);
	    const upload: UploadedAttachment = { id, token, name, mime, size, chunkCount, createdAt: Date.now() };
	    let prunedUploads: UploadedAttachment[] = [];
	    try {
	      const state = await this.get();
	      const unprunedUploads = { ...(state.uploads ?? {}), [id]: upload };
	      state.uploads = pruneUploads(unprunedUploads);
	      prunedUploads = Object.entries(unprunedUploads)
	        .filter(([uploadId]) => !state.uploads?.[uploadId])
	        .map(([, value]) => value);
	      await this.put(state);
	    } catch (error) {
	      await this.deleteUploadBytes(upload);
	      throw error;
	    }
	    await this.deleteUploads(prunedUploads);
	    const base = request.headers.get("X-King-AI-Public-Base") || new URL(request.url).origin;
	    const tenantId = tenantHeader(request);
	    return json({
	      attachment: {
	        id,
	        name,
	        mime,
	        size,
	        url: `${base}/gui/attachments/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}&tenant=${encodeURIComponent(tenantId)}`,
	        source: "gui-upload"
	      }
	    });
	  }

	  private async guiAttachmentFile(url: URL, attachmentId: string): Promise<Response> {
	    const state = await this.get();
	    const upload = state.uploads?.[attachmentId];
	    if (!upload || url.searchParams.get("token") !== upload.token) return json({ error: "attachment not found" }, { status: 404 });
	    const bytesBase64 = await this.readUploadBytes(upload);
	    if (!bytesBase64) return json({ error: "attachment not found" }, { status: 404 });
	    const bytes = base64ToBytes(bytesBase64);
	    return new Response(bytes, {
	      headers: {
	        "Content-Type": upload.mime,
	        "Content-Length": String(bytes.byteLength),
	        "Content-Disposition": `attachment; filename="${upload.name.replace(/["\r\n]/g, "_")}"`
	      }
	    });
	  }

	  private async writeUploadBytes(id: string, bytesBase64: string): Promise<number> {
	    const chunkCount = Math.max(1, Math.ceil(bytesBase64.length / GUI_ATTACHMENT_CHUNK_CHARS));
	    const writtenKeys: string[] = [];
	    try {
	      for (let index = 0; index < chunkCount; index += 1) {
	        const key = uploadChunkKey(id, index);
	        await this.state.storage.put(key, bytesBase64.slice(index * GUI_ATTACHMENT_CHUNK_CHARS, (index + 1) * GUI_ATTACHMENT_CHUNK_CHARS));
	        writtenKeys.push(key);
	      }
	      return chunkCount;
	    } catch (error) {
	      await Promise.all(writtenKeys.map((key) => this.state.storage.delete(key)));
	      throw error;
	    }
	  }

	  private async readUploadBytes(upload: UploadedAttachment): Promise<string | null> {
	    if (upload.bytesBase64) return upload.bytesBase64;
	    if (!upload.chunkCount || upload.chunkCount < 1) return null;
	    const chunks = await Promise.all(
	      Array.from({ length: upload.chunkCount }, (_, index) => this.state.storage.get<string>(uploadChunkKey(upload.id, index)))
	    );
	    if (chunks.some((chunk) => typeof chunk !== "string")) return null;
	    return chunks.join("");
	  }

	  private async deleteUploadBytes(upload: UploadedAttachment): Promise<void> {
	    if (!upload.chunkCount || upload.chunkCount < 1) return;
	    await Promise.all(
	      Array.from({ length: upload.chunkCount }, (_, index) => this.state.storage.delete(uploadChunkKey(upload.id, index)))
	    );
	  }

	  private async deleteUploads(uploads: UploadedAttachment[]): Promise<void> {
	    await Promise.all(uploads.map((upload) => this.deleteUploadBytes(upload)));
	  }

	  private async guiWake(payload: unknown): Promise<Response> {
    await this.broadcast({ event: "wake", data: { ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : {}), at: Date.now() } });
    return json({ ok: true });
  }

  private async remoteAssistShare(request: Request): Promise<Response> {
    const state = await this.get();
    const tokenValue = crypto.randomUUID();
    const tokenHash = await sha256Hex(tokenValue);
    const now = Date.now();
    const tenantId = tenantHeader(request);
    state.remoteAssist = {
      tokenHash,
      tokenPreview: `${tokenValue.slice(0, 8)}...${tokenValue.slice(-4)}`,
      createdAt: now,
      createdBy: displayNameForAuthUser(authUserFromRequest(request)),
      uses: 0
    };
    await this.put(state);
    const publicBase = request.headers.get("X-King-AI-Public-Base") || new URL(request.url).origin;
    const url = new URL(publicBase);
    url.searchParams.set("tenant", tenantId);
    url.searchParams.set("assist", tokenValue);
    return json({ ok: true, url: url.toString(), remoteAssist: remoteAssistSummary(state.remoteAssist) });
  }

  private async remoteAssistRevoke(): Promise<Response> {
    const state = await this.get();
    if (state.remoteAssist) state.remoteAssist.revokedAt = Date.now();
    await this.put(state);
    return json({ ok: true, remoteAssist: state.remoteAssist ? remoteAssistSummary(state.remoteAssist) : { active: false } });
  }

  private async remoteAssistAuth(payload: { token?: unknown }): Promise<Response> {
    const state = await this.get();
    const tokenValue = typeof payload.token === "string" ? payload.token.trim() : "";
    const grant = activeRemoteAssistGrant(state);
    if (!grant || !tokenValue || await sha256Hex(tokenValue) !== grant.tokenHash) {
      return json({ error: "invalid remote assist token" }, { status: 401 });
    }
    grant.lastUsedAt = Date.now();
    grant.uses = (grant.uses ?? 0) + 1;
    await this.put(state);
    return json({ ok: true, remoteAssist: remoteAssistSummary(grant) });
  }

  private async guiMarkRead(payload: { conversationId?: string; upToMessageId?: string }): Promise<Response> {
    return this.markRead({
      conversationId: payload.conversationId || "king-ai-convo",
      upToMessageId: payload.upToMessageId
    });
  }

  private newCard(state: State, title: string, assignee?: string, allowedPaths: string[] = []): Card {
    const card: Card = {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      title,
      column: "todo",
      assignee,
      allowedPaths,
      created_at: Date.now()
    };
    state.cards.push(card);
    return card;
  }

  private async createCard(payload: { title?: string; assignee?: string; allowedPaths?: string[] }): Promise<Response> {
    const state = await this.get();
    const allowedPaths = Array.isArray(payload.allowedPaths) ? payload.allowedPaths.filter((path): path is string => typeof path === "string") : [];
    const card = this.newCard(state, payload.title || "Gui card", payload.assignee, allowedPaths);
    await this.put(state);
    await this.broadcast({ event: "wake", data: { agenda: true, cardId: card.id, at: Date.now() } });
    return json({ ok: true, card });
  }

  private async moveCard(cardId: string | undefined, payload: GuiCardMovePayload): Promise<Response> {
    const state = await this.get();
    if (!cardId) return json({ error: "card not found" }, { status: 404 });
    const card = state.cards.find((row) => row.id === cardId || row.id.startsWith(cardId));
    if (!card) return json({ error: `card not found: ${cardId || ""}` }, { status: 404 });
    const column = payload.column;
    if (column !== "todo" && column !== "doing" && column !== "done") return json({ error: "column must be todo, doing, or done" }, { status: 400 });
    card.column = column;
    if (typeof payload.owner === "string" && payload.owner.trim()) {
      card.assignee = payload.owner.trim();
      card.claimedBy = payload.owner.trim();
    }
    if (column === "done") card.claimedBy = undefined;
    await this.put(state);
    await this.broadcast({ event: "wake", data: { agenda: true, cardId: card.id, at: Date.now() } });
    return json({ ok: true, card });
  }

  private async createTask(payload: GuiTaskPayload): Promise<Response> {
    const state = await this.get();
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Gui task";
    const description = typeof payload.description === "string" && payload.description.trim() ? payload.description.trim() : undefined;
    const assignee = typeof payload.assignee === "string" && payload.assignee.trim() ? payload.assignee.trim() : defaultWorkerAgentFor(state).id;
    const ownerRole = typeof payload.ownerRole === "string" && payload.ownerRole.trim() ? payload.ownerRole.trim() : "builder";
    const reviewerRole = typeof payload.reviewerRole === "string" && payload.reviewerRole.trim() ? payload.reviewerRole.trim() : (findAgent(state, "reviewer") ? "reviewer" : undefined);
    const priority = typeof payload.priority === "number"
      ? Math.min(10, Math.max(1, Math.round(payload.priority)))
      : 5;
    const paths = normalizeStringList(payload.paths);
    const dependsOn = normalizeStringList(payload.dependsOn);
    const blockedBy = normalizeStringList(payload.blockedBy);
    const acceptance = normalizeStringList(payload.acceptance);
    const task = workflowAddGuiTaskToState(state, {
      title,
      description,
      status: assignee ? "assigned" : "pending",
      assignee,
      ownerRole,
      reviewerRole,
      priority,
      dependsOn: dependsOn.length ? dependsOn : undefined,
      blockedBy: blockedBy.length ? blockedBy : undefined,
      acceptance: acceptance.length ? acceptance : ["Assigned work has concrete output and verification evidence."],
      scope: paths.length ? { paths } : undefined
    }) as Task;
    queueTaskAssignmentMessage(state, task, "King AI");
    pushLoopEvent(state, {
      type: "queue.backlog",
      agent: assignee,
      taskId: task.id,
      pendingMessages: unreadMessagesFor(state, assignee).length,
      payload: { taskId: task.id, source: "gui-ui" }
    });
    await this.put(state);
    if (payload.wake !== false) await this.broadcast({ event: "wake", data: { agenda: true, taskId: task.id, agentId: assignee, at: Date.now() } });
    return json({ ok: true, task });
  }

  private async updateTask(taskId: string | undefined, payload: GuiTaskUpdatePayload): Promise<Response> {
    const state = await this.get();
    const lookup = lookupTask(state, taskId);
    if (!lookup.task) return json({ error: lookup.error }, { status: lookup.ambiguous ? 409 : 404 });
    const task = lookup.task;
    const previousStatus = task.status;
    const reviewResult = payload.reviewResult === "approved" || payload.reviewResult === "changes_requested" ? payload.reviewResult : undefined;
    const blockedBy = normalizeStringList(payload.blockedBy);
    const acceptance = normalizeStringList(payload.acceptance);
    if (typeof payload.status === "string") {
      if (!isTaskStatus(payload.status)) return json({ error: `invalid task status: ${payload.status}` }, { status: 400 });
    }
    workflowUpdateGuiTaskFromPatch(task, {
      status: typeof payload.status === "string" && isTaskStatus(payload.status) ? payload.status : undefined,
      assignee: typeof payload.assignee === "string" && payload.assignee.trim() ? payload.assignee.trim() : undefined,
      ownerRole: typeof payload.ownerRole === "string" ? payload.ownerRole.trim() : undefined,
      reviewerRole: typeof payload.reviewerRole === "string" ? payload.reviewerRole.trim() : undefined,
      blockedBy: blockedBy.length ? blockedBy : undefined,
      acceptance: acceptance.length ? acceptance : undefined,
      result: typeof payload.result === "string" ? payload.result.trim() : undefined,
      reviewResult,
      revisionReason: typeof payload.revisionReason === "string" ? payload.revisionReason : undefined,
      artifactIds: payload.artifactIds !== undefined ? normalizeStringList(payload.artifactIds) : undefined,
      reviewedByAgentId: reviewResult ? findAgent(state, task.assignee)?.id : undefined,
      reviewedAt: reviewResult ? Date.now() : undefined
    });
    if (task.reviewResult === "changes_requested" && task.revisionReason) {
      const worker = task.requestMessageId && task.conversationId
        ? workerAgentForConversation(state, ensureConversation(state, task.conversationId))
        : defaultWorkerAgentFor(state);
      const targetWorker = worker ?? defaultWorkerAgentFor(state);
      task.status = "assigned";
      task.assignee = targetWorker.id;
      task.updated_at = Date.now();
      if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
      queueTaskChangesRequestedMessage(state, task, targetWorker.id);
      await this.put(state);
      await this.broadcast({ event: "wake", data: { agenda: true, taskId: task.id, agentId: task.assignee, at: Date.now() } });
      return json({ ok: true, task });
    }
    if (previousStatus !== task.status) {
      pushTaskTransition(state, task, previousStatus);
      if (task.status === "review") {
        const reviewer = findAgent(state, task.reviewerAgentId);
        if (reviewer) {
          task.assignee = reviewer.id;
          task.reviewerAgentId = reviewer.id;
          queueTaskReviewMessage(state, task, defaultAgentFor(state).id);
        } else {
          const reviewStatus = task.status;
          task.status = "done";
          task.assignee = task.coordinatorAgentId ?? defaultAgentFor(state).id;
          task.updated_at = Date.now();
          pushTaskTransition(state, task, reviewStatus);
          queueTaskCompletionMessage(state, task, { fromName: defaultAgentFor(state).id, actorAgentId: defaultAgentFor(state).id });
        }
      } else if (task.status === "done") {
        task.assignee = task.coordinatorAgentId ?? defaultAgentFor(state).id;
        queueTaskCompletionMessage(state, task, { fromName: defaultAgentFor(state).id, actorAgentId: defaultAgentFor(state).id });
      } else if (task.assignee) {
        queueTaskAssignmentMessage(state, task, "King AI");
      }
    }
    await this.put(state);
    await this.broadcast({ event: "wake", data: { agenda: true, taskId: task.id, agentId: task.assignee, at: Date.now() } });
    return json({ ok: true, task });
  }

  private newAgentMessage(args: {
    target: string;
    fromId?: string;
    fromName: string;
    fromKind: Message["author_kind"];
    fromEngine?: Message["author_engine"];
    body: string;
    priority: "normal" | "steer";
    messageType: "message" | "decision" | "blocker";
    payload?: unknown;
  }): Message {
    return {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      conversation_id: `dm-${(args.fromId ?? args.fromName).toLowerCase().replace(/\s+/g, "-")}-${args.target}`,
      conversation_title: `DM ${args.target}`,
      conversation_kind: "direct",
      author_name: args.fromName,
      author_kind: args.fromKind,
      author_engine: args.fromEngine,
      kind: "message",
      body: args.body,
      priority: args.priority,
      message_type: args.messageType,
      to_agent_id: args.target,
      payload: args.payload,
      created_at: Date.now(),
      readBy: []
    };
  }

  private async clearMessages(payload?: { conversationId?: string }): Promise<Response> {
    const state = await this.get();
    const conversationId = typeof payload?.conversationId === "string" ? payload.conversationId.trim() : "";
    if (conversationId) {
      state.messages = state.messages.filter((message) => message.conversation_id !== conversationId);
      state.cliLog = state.cliLog.filter((row) => !row.argv.includes(conversationId));
      state.typingLog = state.typingLog.filter((row) => row.conversationId !== conversationId);
      state.thinkingLog = state.thinkingLog.filter((row) => !row.conversationIds.includes(conversationId));
      const conversation = state.conversations.find((row) => row.id === conversationId);
      if (conversation) conversation.updated_at = Date.now();
      clearRunStateForConversation(state, conversationId);
      await this.put(state);
      await this.broadcast({ event: "wake", data: { clearedConversationId: conversationId, at: Date.now() } });
      return json({ ok: true, conversationId });
    }
    state.messages = [];
    state.cliLog = [];
    state.statusLog = [];
    state.typingLog = [];
    state.thinkingLog = [];
    state.eventLog = [];
    state.eventRoutes = [];
    state.loopRunId = "run-gui";
    state.currentLoop = 0;
    state.loopEvents = [];
    state.noticeLog = [];
    state.triageLog = [];
    state.runLog = [];
    state.runStreams = {};
    state.activeRunContracts = {};
    state.runActions = {};
    state.initiatives = [];
    state.tasks = [];
    state.taskEvents = [];
    state.capsules = [];
    state.mergeQueue = [];
    state.evaluations = [];
    state.runFeedback = [];
    state.reviews = [];
    state.cards = [];
    state.calendar = [];
    state.claims = [];
    state.docs = [];
    state.artifacts = [];
    state.context = [];
    state.hypotheses = [];
    state.approvals = [];
    state.reactions = [];
    state.composing = [];
    await this.put(state);
    return json({ ok: true });
  }

  private async agentConfig(payload: AgentConfigPayload): Promise<Response> {
    const state = await this.get();
    const previous = defaultAgentFor(state);
    const engine = typeof payload.engine === "string" && state.availableEngines.includes(payload.engine) ? payload.engine : previous.engine;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const role = typeof payload.role === "string" ? payload.role.trim() : "";
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    const fastModel = typeof payload.fastModel === "string" ? payload.fastModel.trim() : "";
    const lifecycle = isAgentLifecycle(payload.lifecycle)
      ? payload.lifecycle
      : previous.lifecycle ?? DEFAULT_AGENT.lifecycle;
    // Engine / model / fastModel / lifecycle are runtime (local CLI) settings that should apply to
    // the whole team hosted on this computer, so propagate them to every agent. Name / role are
    // coordinator-specific and only update the default operator agent.
    const nextEngine = engine === "claude" || engine === "codex" ? engine : DEFAULT_AGENT.engine;
    const nextModel = model || undefined;
    const nextFastModel = fastModel || undefined;
    const agents = normalizeAgents(state.agents);
    const previousAgents = agents;
    state.agents = agents.map((agent) => {
      const isDefault = agent.id === previous.id;
      return {
        ...agent,
        name: isDefault ? name || agent.name || DEFAULT_AGENT.name : agent.name,
        role: isDefault ? role || agent.role || DEFAULT_AGENT.role : agent.role,
        engine: nextEngine,
        lifecycle,
        model: nextModel,
        fastModel: nextFastModel
      };
    });
    const nextAgent = state.agents.find((agent) => agent.id === previous.id) ?? defaultAgentFor(state);
    const changed = previousAgents.some((before) => {
      const after = state.agents.find((agent) => agent.id === before.id);
      return !after
        || before.name !== after.name
        || before.role !== after.role
        || before.engine !== after.engine
        || before.lifecycle !== after.lifecycle
        || before.model !== after.model
        || before.fastModel !== after.fastModel;
    });
    state.agentConfigUpdatedAt = Date.now();
    if (changed) {
      // Every agent's config changed, so invalidate all runtime tokens to force a clean re-host.
      state.runtimeToken = crypto.randomUUID();
      state.runtimeTokens = {};
      state.runtimeTokenMeta = {};
    }
    await this.put(state);
    if (changed) {
      // Push a config event so connected runners re-sync immediately instead of waiting for the
      // next poll, which makes engine/model switches take effect within ~1s.
      await this.broadcast({ event: "config", data: { config: true, at: Date.now() } });
    }
    return json({ ok: true, agent: nextAgent });
  }

  private async broadcast(evt: { event: string; data: unknown }): Promise<void> {
    let event = evt;
    try {
      const state = await this.get();
      if (evt.event === "wake" && evt.data && typeof evt.data === "object") {
        event = resolveWakeEvent(
          wakeResolveContextFromState({
            agents: state.agents,
            cards: state.cards,
            tasks: state.tasks,
            conversations: state.conversations,
            defaultConversationId: DEFAULT_CONVERSATION.id,
            defaultCoordinatorAgentId: DEFAULT_AGENT.id
          }),
          evt
        );
      }
      state.wakeLog ??= [];
      state.wakeLog.push({ at: Date.now(), event: event.event, data: event.data });
      state.wakeLog = state.wakeLog.slice(-WAKE_LOG_CAPACITY);
      await this.put(state);
    } catch {
      // Wake delivery must not depend on observability persistence.
    }
    const frame = encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
    // GUI clients only need a "something changed" nudge, so collapse every event into one frame.
    const guiFrame = encode(`event: change\ndata: ${JSON.stringify({ event: event.event, at: Date.now() })}\n\n`);
    await Promise.all([...this.waiters].map(async (waiter) => {
      if (!waiter.gui && !wakeEventVisibleToAgent(event, waiter.agentId)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          waiter.writer.write(waiter.gui ? guiFrame : frame),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("sse write timeout")), 1000);
          })
        ]);
      } catch {
        this.waiters.delete(waiter);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
  }
}
import {
  token,
  tenantHeader,
  normalizeAgentId,
  normalizeRuntimeTokens,
  normalizeRuntimeTokenMeta,
  entityStateStorageKey,
  stableStorageValue,
  stripEntityState,
  normalizeRemoteAssistGrant,
  activeRemoteAssistGrant,
  remoteAssistSummary,
  isAgentLifecycle,
  normalizeMessages,
  stateForGui,
  normalizeTasks,
  normalizeTaskEvents,
  normalizeCards,
  normalizeCalendar,
  normalizeClaims,
  normalizeCapsules,
  normalizeMergeQueue,
  normalizeArtifacts,
  normalizeContext,
  normalizeHypotheses,
  normalizeReactions,
  normalizeComposing,
  normalizeConversations,
  ensureConversation,
  findConversation,
  defaultTeamAgents,
  normalizeWorkflowAgentIds,
  normalizeWorkflowAgentDefinitions,
  upsertAgents,
  workflowTemplateByIdOrUndefined,
  normalizeConversationTeam,
  normalizeAgentRolePayload,
  buildConversationTeamSnapshot,
  normalizeAgents,
  findAgent,
  defaultAgentFor,
  coordinatorAgentFor,
  teamAgentsFor,
  defaultWorkerAgentFor,
  workerAgentForConversation,
  agentIdForRuntimeToken,
  autoDelegateMessage,
  advanceTaskDone,
  pushTaskTransition,
  applyTaskReviewPayload,
  queueTaskAssignmentMessage,
  queueTaskReviewMessage,
  queueTaskChangesRequestedMessage,
  queueTaskCompletionMessage,
  conversationSummaries,
  workflowSummaries,
  workflowSummary,
  isRuntimeVisibleMessage,
  unreadMessagesFor,
  normalizeCapabilities,
  normalizeStringList,
  normalizeRunContract,
  resolveRunContract,
  pruneActiveRunContracts,
  pruneRunStreams,
  validateRunContractAction,
  recordRunAction,
  pruneRunActions,
  clearRunStateForConversation,
  isTaskMutationCommand,
  isCliUsageOrError,
  runtimeBodyStatus,
  runtimeBodyEngine,
  normalizeRunStreamEvent,
  approximateBase64Bytes,
  base64ToBytes,
  uploadChunkKey,
  pruneUploads,
  normalizeEngineId,
  activeRunEngine,
  summarizeUnknown,
  agentStateSummary,
  formatRosterAgent,
  buildRuntimePreamble,
  formatEventRouteLine,
  parseExternalEventArgs,
  parseEventPayload,
  normalizeExternalEvent,
  routeExternalEvent,
  formatAgentMatrixLine,
  pushLoopEvent,
  isLoopEventType,
  buildEventLoopSnapshot,
  countPendingMessages,
  formatLoopEventLine,
  buildLoopSnapshot,
  isTaskStatus,
  isInitiativeStatus,
  isCapsuleStatus,
  isCapsuleScopeType,
  normalizePriority,
  parseCsvOption,
  taskScopeFromArgs,
  lookupTask,
  pendingBelongsToAgent,
  updatePendingForTask,
  taskVisibleStatus,
  formatTaskLine,
  findInitiative,
  formatInitiativeLine,
  findCapsule,
  formatCapsuleLine,
  isMergeStatus,
  isSafeBranchName,
  findMergeRequest,
  formatMergeRequestLine,
  findEvaluation,
  formatEvaluationLine,
  formatEvaluationSummary,
  findRunFeedback,
  parseRunFeedback,
  formatRunFeedbackLine,
  summarizeRunFeedback,
  formatRunFeedbackSummaryLine,
  findReview,
  parseReviewRecord,
  formatReviewLine,
  capsuleConflicts,
  findArtifact,
  artifactCandidateFromArgs,
  checkArtifactQuality,
  formatArtifactQualityCheck,
  parseMetadataJson,
  formatArtifactLine,
  isHypothesisStatus,
  findHypothesis,
  formatHypothesisLine,
  firstJsonArg,
  parseExecutionPlan,
  parseEvaluationRecord,
  isSafetyAction,
  safetyCheck,
  parseSafetyContext,
  stringContextValue,
  findApproval,
  formatApprovalLine,
  readOption,
  readBooleanOption,
  readNumberOption,
  normalizePositiveInt,
  stripOptions,
  parseAllowedPaths,
  pathConflict,
  taskScopeConflicts
} from "./gui-runtime.js";

export {
  resolveWakeEvent,
  resolveWakeData,
  shouldAutoDelegateMessage,
  triageResponseMode,
  wakeEventVisibleToAgent,
  wakeResolveContextFromState
};

export default app;
