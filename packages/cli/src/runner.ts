import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { api, runtimeGet, runtimeGetStrict, runtimePost, runtimePostStrict, tenantHeader } from "./api.js";
import { AGENTS_ROOT, SESSIONS_DIR, TRIAGE_DIR } from "./paths.js";
import { formatEngineLogLine, getAdapter, parseTriage } from "./engine.js";
import { parseSseStream } from "./sse.js";
import { writeShim } from "./shim.js";
import type { AgentConfig, ComputerConfig, EngineAdapter, EngineId, EngineSession, RuntimeRun, RuntimeRunContract, TriageVerdict } from "./types.js";
import { authFailureHint, concise, hashText, isRateLimited } from "./text.js";
import { agentWorkspaceRoot, detectLocalCapabilities, formatWorkspacePolicy } from "./workspace.js";
import { formatWorktreePlanForPrompt, formatWorktreePreparationResults, planAgentWorktrees, prepareWorktreePlans } from "./worktree.js";
import type { RunningAgentState } from "./service.js";
import { checkTokenBudget, emptyAgentRunStats, recordAgentRunStats, tokenBudgetFromEnv } from "./usage.js";
import type { AgentRunStats } from "./usage.js";
import { normalizeAgentLifecycle, runtimeLifecycleNote } from "./lifecycle.js";
import { installSharedSkills } from "./shared-skills.js";
import type { SharedSkillSnapshot } from "./shared-skills.js";
import { linkHostHomeEntries } from "./host-home.js";
import type { HostHomeEntry } from "./host-home.js";
import { formatMessageRouteSummary, messageRouteTag, sortRuntimeMessages } from "./message-routing.js";
import { cacheLocalAttachments, formatAttachmentPrompt, normalizeRuntimeAttachments } from "./attachments.js";
import { engineRemediationAdvice } from "./remediation.js";
import type { RemediationAdvice } from "./remediation.js";
import { validateAgentConfig } from "./agent-config-validation.js";
import type { AgentConfigWarning } from "./agent-config-validation.js";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const INBOX_POLL_MS = Number(process.env.KING_AI_INBOX_POLL_MS) || 20_000;
const WAKE_DEBOUNCE_MS = Number(process.env.KING_AI_WAKE_DEBOUNCE_MS) || 2500;
const RUN_HEARTBEAT_MS = Number(process.env.KING_AI_RUN_HEARTBEAT_MS) || 60_000;
const TRIAGE_TIMEOUT_MS = Number(process.env.KING_AI_TRIAGE_TIMEOUT_MS) || 30_000;
const ENGINE_BACKOFF_MS = Number(process.env.KING_AI_ENGINE_BACKOFF_MS) || 60_000;
const TRIAGE_BACKOFF_MAX_MS = Number(process.env.KING_AI_TRIAGE_BACKOFF_MAX_MS) || 600_000;
const BIG_BRAIN_SPAWN_JITTER_MS = Number(process.env.KING_AI_BYOA_BIG_BRAIN_SPAWN_JITTER_MS) || 1500;
const TRIAGE_SPAWN_JITTER_MS = Number(process.env.KING_AI_BYOA_TRIAGE_SPAWN_JITTER_MS) || 500;
const AGENDA_QUIET_MS = Number(process.env.KING_AI_AGENDA_QUIET_MS) || 180_000;
const AGENDA_CHECK_MS = Number(process.env.KING_AI_AGENDA_CHECK_MS) || 120_000;
const PREPARE_WORKTREES = process.env.KING_AI_PREPARE_WORKTREES === "1" || process.env.KING_AI_AGENT_PREPARE_WORKTREES === "1";
const NESTED_ENV_BLOCKLIST = [
  "CODEX_CI",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "CODEX_THREAD_ID",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "KING_AI_AGENT_RUNTIME_URL",
  "KING_AI_AGENT_RUNTIME_TOKEN",
  "KING_AI_AGENT_RUNTIME_TOKEN_FILE",
  "KING_AI_AGENT_RUNTIME_TENANT",
  "KING_AI_AGENT_RUNTIME_RUN_ID",
  "KING_AI_AGENT_RUNTIME_CONTRACT",
  "KING_AI_AGENT_ID",
  "KING_AI_AGENT_ENGINE",
  "KING_AI_AGENT_HOME",
  "KING_AI_AGENT_WORKSPACE_ROOT",
  "KING_AI_AGENT_WORKSPACES",
  "KING_AI_AGENT_WORKTREE_PLAN",
  "KING_AI_AGENT_SKILL_SNAPSHOT_ID",
  "KING_AI_AGENT_SKILL_SNAPSHOT_PATH",
  "KING_AI_AGENT_SKILL_SNAPSHOT_MANIFEST"
] as const;

interface InboxRow {
  id?: string;
  conversation_id?: string;
  conversation_title?: string;
  conversation_kind?: string;
  conversation_topic?: string;
  author_name?: string;
  author_kind?: string;
  kind?: string;
  body?: string;
  attachments?: unknown;
  priority?: string;
  message_type?: string;
  to_agent_id?: string;
  created_at?: number;
}

interface InboxPayload {
  rows?: InboxRow[];
}

interface RunActionsPayload {
  actions?: Array<{
    kind?: string;
    conversationId?: string;
    messageId?: string;
    requestId?: string;
    taskId?: string;
  }>;
}

interface TriagePayload {
  verdict?: TriageVerdict;
  instructions?: string;
  input?: string;
}

interface AgendaPayload {
  actionable?: boolean;
  brief?: string;
  focus?: string;
}

interface RuntimePreamblePayload {
  text?: string;
}

export interface WakeEventInfo {
  conversationId: string | null;
  requestId: string | null;
  messageId: string | null;
  taskId: string | null;
  agentId: string | null;
  sentAt: number | null;
  deliveryLatencyMs: number | null;
  resetState: boolean;
}

export class Semaphore {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.inFlight < this.max) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight += 1;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }

  get queueDepth(): number {
    return this.waiters.length;
  }
}

function envConcurrency(name: string, fallback: number): number {
  const n = Number(process.env[name] || fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const bigBrainSem = new Semaphore(envConcurrency("KING_AI_BYOA_MAX_CONCURRENT_BIG_BRAIN", 2));
const triageSem = new Semaphore(envConcurrency("KING_AI_BYOA_MAX_CONCURRENT_TRIAGE", 4));

function usageForRuntime(usage: unknown): unknown {
  if (!usage || typeof usage !== "object") return null;
  return usage;
}

export function sanitizeNestedEngineEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of NESTED_ENV_BLOCKLIST) delete clean[key];
  for (const key of Object.keys(clean)) {
    if (key.startsWith("ORCA_") || key.startsWith("OPENAI_CODEX_")) delete clean[key];
  }
  return clean;
}

export function selectSteerMessage(rows: InboxRow[], conversationId: string, agentId: string, lastSteeredMsgId?: string | null): InboxRow | null {
  const inConversation = sortRuntimeMessages(rows.filter((row) => row.conversation_id === conversationId), agentId)
    .filter((item) => item.route === "steer" || item.route === "respond")
    .map((item) => item.row);
  if (inConversation.length === 0) return null;
  return inConversation.find((row) => row.id && row.id !== lastSteeredMsgId) ?? null;
}

export function formatSteerPrompt(row: InboxRow, conversationId: string, agentId = row.to_agent_id ?? ""): string {
  const who = row.author_name ?? "someone";
  const body = (row.body ?? "").replace(/\s+/g, " ").slice(0, 300);
  const routed = sortRuntimeMessages([row], agentId)[0];
  const tag = routed ? messageRouteTag(routed) : "message";
  return `A ${tag} runtime message arrived while you work. Answer it briefly if it needs you, then resume your current task. ${who} in ${conversationId}: "${body}". Reply one line now with: king-ai reply ${conversationId} 'text'. Then continue what you were doing.`;
}

export function buildStandingPrompt(workspaces: string[] = [], agentRoot?: string, worktreeNote = ""): string {
  return `You are a local BYOA teammate agent with your own voice. Use the king-ai CLI on PATH to interact with the runtime.

Privacy boundary: this machine belongs to the operator. Stay inside your private agent home unless the operator explicitly asks otherwise in this runtime.
${formatWorkspacePolicy(workspaces, agentRoot)}
${worktreeNote}

Shared skills: when KING_AI_SHARED_SKILLS is configured, the daemon copies every skill directory containing SKILL.md into .claude/skills and .codex/skills in this agent home before starting you.
The daemon also writes an activation snapshot under .king-ai/skill-snapshots, or KING_AI_SKILL_SNAPSHOTS_DIR when configured, so a run can audit exactly which skill files were available.

Host home entries: when KING_AI_HOST_HOME_ENTRIES is configured, the operator has explicitly linked selected host-home dotfiles or dot directories into this agent home. Treat them as sensitive credentials/configuration and use them only for the runtime task.

Remote test diagnostics: when a human asks you to investigate bugs, logs, database records, Redis state, or statistics on test environments, use king-ai host remote-list --json to discover configured devices and autonomously use king-ai host remote-profile, king-ai host remote-probe, king-ai host remote-run, king-ai host remote-logs, king-ai host remote-find-logs, king-ai host remote-pg, and king-ai host remote-redis. Do not ask the human for SSH commands unless the target device, app, or business object is missing. When reporting, include conclusion, evidence sources, checked scope, and remaining unknowns.

Memory: durable memory lives in memory/MEMORY.md and detail files under memory/. When asked to remember something, write it to a memory file and add a one-line pointer to MEMORY.md.

Coordination:
- Before you commit a reply or shared tool action, run king-ai glance <conversationId>. Treat the composing list as raised hands ordered by who started first.
- If another teammate already posted the same angle, do not repeat it. React, stay silent, or build on it only when you add something new.
- If a teammate has an earlier composing claim and your planned reply or shared tool action is redundant, wait and glance again until their claim clears or their reply lands.
- For shared resources, especially doc create, calendar create, group-level mutations, games, moderation, or one concrete deliverable, announce or claim before doing the work. Prefer king-ai card claim <cardId> for real work and king-ai claim <name> --in <conversationId> for short-lived locks.
- Trust board cards and claims over your memory. If a card is done or someone owns the same lock, do not duplicate the work.
- For sequence, relay, round-robin, no-duplicates, or "who starts" tasks, continue from the newest visible message. Never restart the count or fork the opener.

Posting: for replies with backticks, code, $, quotes, or multiple lines, write a draft under notes/ and send it with king-ai reply <conversationId> --file notes/reply.md or king-ai reply <conversationId> --file notes/reply.md. For short plain text, king-ai reply <conversationId> '<text>' is fine. When answering a specific message, use --quote <messageId>. Address teammates by @<agent-id>, not by display name.

Expressiveness: King AI clients can render Skype shortcode text such as (smile), (clap), (ok), (think), (coffee), or (wfh). Use at most one when it genuinely helps tone; plain text is usually better.

Drive what you own forward. Multi-step turns are fine. If someone DMs you mid-task, answer briefly and continue. If progress is waiting on someone else, send one short follow-up and schedule a check-back with king-ai calendar create '<chase>' --at <iso> --assignee <your-agent-id> --prompt '<what future-you should do>'.

Useful runtime commands include king-ai inbox, messages <conversationId> --tail 30, glance <conversationId>, roster, participants, contacts, whoami, agenda, observe [--json], initiative create|list|get|update, task list|create|update|done, capsule create|list|mine|get|update, artifact put|list|get, hypothesis create|list|update, context get|set|list, send <agentId> <message>, recv [--agent agent-id], escalate <message>, calendar list, card list, dm <agentId> <text>, react <messageId> <emoji>, and doc list|create|show.`;
}

export function shouldStopEngineOnBeginStop(): boolean {
  return false;
}

export function visibleEngineError(engine: EngineId, home: string, exitCode: number, detail?: string): string {
  const raw = concise(detail || `process exited with code ${exitCode}`);
  const homeDir = homedir();
  const userHomePattern = String.raw`(?:\/Users\/[^/\s"']+|\/home\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+)`;
  const redacted = raw
    .split(home)
    .join("<agent home>")
    .split(homeDir)
    .join("~")
    .replace(new RegExp(userHomePattern, "g"), "~");
  return `local ${engine} failed (exit ${exitCode}): ${redacted}`;
}

export function formatTriageNote(triage?: TriageVerdict | null): string {
  if (!triage) return "";
  const state = triage.actionable === false ? "not relevant" : "relevant";
  const source = triage.source ?? "server";
  const note = triage.promptNote?.trim();
  const reason = triage.reason?.trim();
  const responseMode =
    triage.responseMode === "me"
      ? "Response mode: me - this wake is specifically for you; answer if the message needs a response."
      : triage.responseMode === "each"
        ? "Response mode: each - every relevant teammate may contribute their own distinct reply."
        : triage.responseMode === "one-of-us"
          ? "Response mode: one-of-us - coordinate with glance/claims so only one teammate handles the reply."
          : "";
  return [
    `Small-brain inbox triage (${state}, ${source}).`,
    responseMode,
    triage.routeHint ? `Route hint: ${triage.routeHint}.` : "",
    triage.priority ? `Priority: ${triage.priority}.` : "",
    note ? `Instruction: ${note}` : "",
    reason ? `Reason: ${reason.slice(0, 500)}` : ""
  ].filter(Boolean).join("\n");
}

export function buildChatDelta(digest: string, memoryDigest: string, rosterDigest: string, triage?: TriageVerdict | null): string {
  const triageNote = formatTriageNote(triage);
  return `You've been woken because there's new runtime activity, and local triage already decided whether you should respond. If triage marked it relevant, your job is to act, not re-litigate whether to wake.

${triageNote ? `${triageNote}\n\n` : ""}Your unread messages (ALREADY FETCHED - no need to re-run king-ai inbox or messages just to reread these; do run king-ai glance before posting in a group to catch anything posted while you compose):
${digest || "(none)"}

Your memory index (memory/MEMORY.md):
${memoryDigest || "(empty)"}

Your team right now (trust over memory - use these current ids for @mentions and king-ai dm):
${rosterDigest || "(unavailable)"}`;
}

export function buildAgendaDelta(brief: string, memoryDigest: string, rosterDigest: string): string {
  return `You've been woken by your own agenda: assigned board work, due calendar items, or follow-up work. The system already triaged that there is real work to progress, so act on one timely item instead of re-deciding whether to wake.

For quiet conversations, first decide if they are genuinely waiting or already concluded. If concluded, do not post; reviving a finished thread is noise. Only when someone is plainly waiting, send at most one useful follow-up.

Agenda:
${brief}

Your memory index (memory/MEMORY.md):
${memoryDigest || "(empty)"}

Your team right now (trust over memory - use these current ids for @mentions and king-ai dm):
${rosterDigest || "(unavailable)"}`;
}

export function buildRuntimePreambleSection(preamble?: string): string {
  const text = preamble?.trim();
  if (!text) return "";
  return `Runtime preamble (current system context):
${text.slice(0, 4000)}`;
}

export function appendRuntimePreamble(delta: string, preamble?: string): string {
  const section = buildRuntimePreambleSection(preamble);
  return section ? `${section}\n\n${delta}` : delta;
}

const CONTEXT_OVERFLOW_RE = /context window|context length|context_length_exceeded|maximum context|reached its context|prompt is too long|input is too long|too many tokens/i;
const POISONED_BODY_RE = /no (?:low|high) surrogate|unpaired surrogate|lone surrogate|surrogate in string|request body is not valid json/i;

export function isContextOverflow(error: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(error);
}

export function isPoisonedTranscript(error: string): boolean {
  return POISONED_BODY_RE.test(error);
}

export function mustResetSession(error: string, hadResume: boolean): boolean {
  if (isContextOverflow(error)) return true;
  if (isPoisonedTranscript(error)) return true;
  if (hadResume && /resume|session|conversation/i.test(error)) return true;
  return false;
}

export function sessionResetReason(error: string): string {
  if (isContextOverflow(error)) return "engine hit its context-window limit";
  if (isPoisonedTranscript(error)) return "transcript poisoned by a malformed character";
  return "engine session problem";
}

export function swallowTurnRejection(task: Promise<void>, onError: (message: string) => void): void {
  void task.catch((err) => {
    onError(err instanceof Error ? err.message : String(err));
  });
}

export function agentSessionFile(agentId: string, engine: EngineId): string {
  return join(SESSIONS_DIR, `${agentId}.${engine}.session`);
}

export function parseWakeEventInfo(rawData: string | undefined, now = Date.now()): WakeEventInfo {
  if (!rawData) return { conversationId: null, requestId: null, messageId: null, taskId: null, agentId: null, sentAt: null, deliveryLatencyMs: null, resetState: false };
  try {
    const data = JSON.parse(rawData) as { conversationId?: unknown; requestId?: unknown; messageId?: unknown; taskId?: unknown; agentId?: unknown; at?: unknown; resetState?: unknown };
    const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
    const messageId = typeof data.messageId === "string" ? data.messageId : null;
    const requestId = typeof data.requestId === "string" ? data.requestId : messageId;
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    const agentId = typeof data.agentId === "string" ? data.agentId : null;
    const sentAt = typeof data.at === "number" && Number.isFinite(data.at) ? data.at : null;
    return {
      conversationId,
      requestId,
      messageId,
      taskId,
      agentId,
      sentAt,
      deliveryLatencyMs: sentAt == null ? null : Math.max(0, now - sentAt),
      resetState: data.resetState === true
    };
  } catch {
    return { conversationId: null, requestId: null, messageId: null, taskId: null, agentId: null, sentAt: null, deliveryLatencyMs: null, resetState: false };
  }
}

export function shouldHandleWakeEvent(info: WakeEventInfo, agentId: string): boolean {
  return !info.agentId || info.agentId === agentId;
}

export class AgentRunner {
  private readonly home: string;
  private readonly binDir: string;
  private readonly sessionFile: string;
  private readonly adapter: EngineAdapter;
  private token = "";
  private tokenExpiresAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private wakeDebounceTimer: NodeJS.Timeout | null = null;
  private wakeStreamController: AbortController | null = null;
  private busy = false;
  private pendingRerun = false;
  private stopped = false;
  private sessionId: string | null = null;
  private engineSession: EngineSession | null = null;
  private engineBackoffUntil = 0;
  private triageBackoffUntil = 0;
  private triageTroubleStreak = 0;
  private lastWakeContract: RuntimeRunContract | null = null;
  private activeRunId: string | null = null;
  private activeRunContract: RuntimeRunContract | null = null;
  private lastTurnEndedAt = 0;
  private lastAgendaCheckAt = 0;
  private sideSteering = false;
  private lastSteeredMsgId: string | null = null;
  private resetInProgress = false;
  private runStats: AgentRunStats = emptyAgentRunStats();
  private lastBudgetEventState: "warning" | "exceeded" | null = null;
  private sharedSkillSnapshot: SharedSkillSnapshot | undefined;
  private hostHomeEntries: HostHomeEntry[] = [];
  private remediation: RemediationAdvice | null = null;

  constructor(
    private readonly cfg: ComputerConfig,
    private readonly agent: AgentConfig,
    engine: EngineId,
    private readonly availableEngines: EngineId[] = [engine],
    private readonly onStateChange?: () => void
  ) {
    this.home = join(AGENTS_ROOT, agent.id);
    this.binDir = join(this.home, "bin");
    this.adapter = getAdapter(engine);
    this.sessionFile = agentSessionFile(agent.id, this.adapter.id);
  }

  get isBusy(): boolean {
    return this.busy;
  }

  runningState(): RunningAgentState {
    return {
      id: this.agent.id,
      name: this.agent.name,
      engine: this.adapter.id,
      lifecycle: normalizeAgentLifecycle(this.agent.lifecycle),
      status: this.busy ? "running" : "idle",
      model: this.agent.model,
      sharedSkillSnapshot: this.sharedSkillSnapshot
        ? {
            id: this.sharedSkillSnapshot.id,
            root: this.sharedSkillSnapshot.root,
            manifestPath: this.sharedSkillSnapshot.manifestPath,
            skills: this.sharedSkillSnapshot.skills.map((skill) => skill.name)
          }
        : null,
      hostHomeEntries: this.hostHomeEntries,
      workspaceRoot: this.workspaceRoot(),
      worktreePlans: this.worktreePlans(),
      worktreeMaterializationEnabled: PREPARE_WORKTREES,
      runStats: this.runStats,
      tokenBudget: checkTokenBudget(this.runStats, tokenBudgetFromEnv()),
      remediation: this.remediation,
      configWarnings: this.configWarnings(),
      updatedAt: new Date().toISOString()
    };
  }

  private configWarnings(): AgentConfigWarning[] {
    return validateAgentConfig(this.agent, this.adapter.id, this.availableEngines);
  }

  private notifyStateChange(): void {
    this.onStateChange?.();
  }

  private workspaceRoot(): string {
    return agentWorkspaceRoot(this.agent.id, this.home);
  }

  private worktreePlans() {
    return planAgentWorktrees({
      agentId: this.agent.id,
      workspaces: detectLocalCapabilities().workspaces,
      baseRoot: this.workspaceRoot()
    });
  }

  configMatches(agent: AgentConfig, engine: EngineId): boolean {
    return (
      this.adapter.id === engine &&
      this.agent.name === agent.name &&
      this.agent.role === agent.role &&
      this.agent.model === agent.model &&
      this.agent.fastModel === agent.fastModel &&
      normalizeAgentLifecycle(this.agent.lifecycle) === normalizeAgentLifecycle(agent.lifecycle)
    );
  }

  async start(): Promise<void> {
    await this.adapter.seedHome(this.home, this.agent);
    this.hostHomeEntries = await linkHostHomeEntries(this.home);
    const sharedSkills = await installSharedSkills(this.home);
    this.sharedSkillSnapshot = sharedSkills.snapshot;
    await mkdir(this.workspaceRoot(), { recursive: true });
    const worktreePlans = this.worktreePlans();
    const worktreePreparation = PREPARE_WORKTREES
      ? await prepareWorktreePlans(worktreePlans, { execute: true })
      : [];
    await writeShim(this.binDir);
    await this.loadSessionId();
    await this.publishEvent("agent.started", {
      engine: this.adapter.id,
      lifecycle: normalizeAgentLifecycle(this.agent.lifecycle),
      lifecycleNote: runtimeLifecycleNote(normalizeAgentLifecycle(this.agent.lifecycle)),
      home: this.home,
      workspaces: detectLocalCapabilities().workspaces,
      worktreePlans,
      worktreeMaterialization: {
        enabled: PREPARE_WORKTREES,
        results: worktreePreparation
      },
      sharedSkillRoots: sharedSkills.sourceRoots,
      sharedSkills: sharedSkills.installed.map((skill) => skill.name),
      sharedSkillSnapshot: sharedSkills.snapshot
        ? {
            id: sharedSkills.snapshot.id,
            root: sharedSkills.snapshot.root,
            manifestPath: sharedSkills.snapshot.manifestPath,
            skills: sharedSkills.snapshot.skills.map((skill) => skill.name)
          }
        : null,
      hostHomeEntries: this.hostHomeEntries
    }, "info", `${this.agent.name} started${PREPARE_WORKTREES ? `; ${formatWorktreePreparationResults(worktreePreparation, true).split("\n")[0]}` : ""}`);
    void this.streamLoop();
    this.pollTimer = setInterval(() => {
      if (!this.busy && !this.stopped) this.scheduleWake("poll");
    }, INBOX_POLL_MS);
  }

  beginStop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.wakeDebounceTimer) clearTimeout(this.wakeDebounceTimer);
    abortWakeStream(this.wakeStreamController);
    this.wakeStreamController = null;
    this.pollTimer = null;
    this.wakeDebounceTimer = null;
  }

  stop(): void {
    this.beginStop();
    this.engineSession?.stop();
    this.engineSession = null;
  }

  private async resetLocalState(): Promise<void> {
    this.engineSession?.stop();
    this.engineSession = null;
    this.sessionId = null;
    this.token = "";
    this.tokenExpiresAt = 0;
    this.pendingRerun = false;
    this.lastWakeContract = null;
    this.activeRunId = null;
    this.activeRunContract = null;
    this.lastSteeredMsgId = null;
    this.remediation = null;
    await rm(this.sessionFile, { force: true });
    await rm(this.home, { recursive: true, force: true });
    this.stopped = false;
    try {
      await this.start();
    } finally {
      this.resetInProgress = false;
    }
  }

  private handleResetLocalState(): void {
    if (this.resetInProgress) return;
    this.resetInProgress = true;
    this.beginStop();
    setTimeout(() => {
      swallowTurnRejection(this.resetLocalState(), (message) => {
        this.resetInProgress = false;
        console.error(`[${this.agent.id}/${this.adapter.id}] resetLocalState rejected (swallowed): ${message}`);
      });
    }, 0);
  }

  scheduleWake(reason: string, contract?: RuntimeRunContract | string | null): void {
    if (this.stopped) return;
    const conversationId = typeof contract === "string" ? contract : contract?.conversationId;
    if (typeof contract === "string") {
      this.lastWakeContract = { conversationId: contract };
    } else if (contract && Object.values(contract).some((value) => typeof value === "string" && value.length > 0)) {
      this.lastWakeContract = contract;
    }
    if (this.busy) {
      this.pendingRerun = true;
      this.kickTurn(reason);
      if (conversationId) void this.maybeSteer(conversationId);
      return;
    }
    if (this.wakeDebounceTimer) return;
    this.wakeDebounceTimer = setTimeout(() => {
      this.wakeDebounceTimer = null;
      this.kickTurn(reason);
    }, WAKE_DEBOUNCE_MS);
    this.wakeDebounceTimer.unref?.();
  }

  private kickTurn(reason: string): void {
    swallowTurnRejection(this.runTurn(reason), (message) => {
      console.error(`[${this.agent.id}/${this.adapter.id}] runTurn rejected (swallowed): ${message}`);
    });
  }

  private steerRunningTurn(text: string): void {
    if (!this.busy || !this.engineSession?.alive || !text.trim()) return;
    this.engineSession.steer(text);
  }

  private async maybeSteer(conversationId: string): Promise<void> {
    const session = this.engineSession;
    if (!session?.alive || this.sideSteering) return;
    this.sideSteering = true;
    try {
      const token = await this.ensureToken();
      const inbox = await runtimeGet<InboxPayload>(this.cfg.serverUrl, "/inbox?probe=1", token, this.cfg.tenantId);
      const latest = selectSteerMessage(inbox?.rows ?? [], conversationId, this.agent.id, this.lastSteeredMsgId);
      if (!latest?.id) return;
      this.lastSteeredMsgId = latest.id;
      session.steer(formatSteerPrompt(latest, conversationId, this.agent.id));
      console.log(`[${this.agent.id}/${this.adapter.id}] steered live turn for ${conversationId}`);
    } catch {
      // Best-effort only; the normal coalesced rerun still handles the inbox.
    } finally {
      this.sideSteering = false;
    }
  }

  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS) return this.token;
    const minted = await api<{ token: string; expiresInSeconds: number }>(
      this.cfg.serverUrl,
      `/api/agents/${this.agent.id}/runtime-token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.deviceToken}`, ...tenantHeader(this.cfg.tenantId) },
        body: "{}"
      }
    );
    this.token = minted.token;
    this.tokenExpiresAt = Date.now() + minted.expiresInSeconds * 1000;
    await mkdir(this.binDir, { recursive: true });
    await writeFile(join(this.binDir, ".runtime-token"), this.token, { mode: 0o600 });
    return this.token;
  }

  private engineEnv(): NodeJS.ProcessEnv {
    const capabilities = detectLocalCapabilities();
    return {
      ...sanitizeNestedEngineEnv(process.env),
      PATH: `${this.binDir}:${process.env.PATH ?? ""}`,
      KING_AI_AGENT_RUNTIME_URL: `${this.cfg.serverUrl}/runtime`,
      KING_AI_AGENT_RUNTIME_TOKEN: this.token,
      KING_AI_AGENT_RUNTIME_TOKEN_FILE: join(this.binDir, ".runtime-token"),
      KING_AI_AGENT_RUNTIME_TENANT: this.cfg.tenantId ?? "",
      KING_AI_AGENT_RUNTIME_RUN_ID: this.activeRunId ?? "",
      KING_AI_AGENT_RUNTIME_CONTRACT: this.activeRunContract ? JSON.stringify(this.activeRunContract) : "",
      KING_AI_AGENT_ID: this.agent.id,
      KING_AI_AGENT_ENGINE: this.adapter.id,
      KING_AI_AGENT_HOME: this.home,
      KING_AI_AGENT_WORKSPACE_ROOT: this.workspaceRoot(),
      KING_AI_AGENT_WORKSPACES: capabilities.workspaces.join(delimiter),
      KING_AI_AGENT_WORKTREE_PLAN: JSON.stringify(this.worktreePlans()),
      KING_AI_AGENT_SKILL_SNAPSHOT_ID: this.sharedSkillSnapshot?.id ?? "",
      KING_AI_AGENT_SKILL_SNAPSHOT_PATH: this.sharedSkillSnapshot?.root ?? "",
      KING_AI_AGENT_SKILL_SNAPSHOT_MANIFEST: this.sharedSkillSnapshot?.manifestPath ?? ""
    };
  }

  private standingPrompt(): string {
    const note = formatWorktreePlanForPrompt(this.worktreePlans()) +
      (PREPARE_WORKTREES ? "\nKING_AI_PREPARE_WORKTREES=1: the daemon attempted to create these local worktrees before starting this agent." : "");
    return buildStandingPrompt(detectLocalCapabilities().workspaces, this.workspaceRoot(), note);
  }

  private async memoryDigest(): Promise<string> {
    try {
      const text = (await readFile(join(this.home, "memory", "MEMORY.md"), "utf8")).trim();
      return text.length > 4000 ? `${text.slice(0, 4000)}\n...(truncated; open memory/MEMORY.md for the rest)` : text;
    } catch {
      return "";
    }
  }

  private async loadSessionId(): Promise<void> {
    try {
      const s = (await readFile(this.sessionFile, "utf8")).trim();
      if (s) {
        this.sessionId = s;
        console.log(`[${this.agent.id}/${this.adapter.id}] restored engine session ${s.slice(0, 8)} from disk; will resume`);
      }
    } catch {
      this.sessionId = null;
    }
  }

  private async setSessionId(id?: string | null): Promise<void> {
    if (id === this.sessionId) return;
    if (!id) {
      await this.clearSessionId();
      return;
    }
    this.sessionId = id;
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(this.sessionFile, id, "utf8");
  }

  private async clearSessionId(): Promise<void> {
    this.sessionId = null;
    await rm(this.sessionFile, { force: true });
  }

  private async resetEngineSession(reason: string): Promise<void> {
    console.warn(`[${this.agent.id}/${this.adapter.id}] ${reason}; starting a fresh engine session next wake`);
    await this.clearSessionId();
    this.engineSession?.stop();
    this.engineSession = null;
  }

  private beatRun(token: string, runId?: string): () => void {
    if (!runId) return () => undefined;
    const beat = () => void runtimePost(this.cfg.serverUrl, `/runs/${runId}/heartbeat`, token, {}, this.cfg.tenantId);
    beat();
    const timer = setInterval(beat, RUN_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }

  private async failureConversationIds(token: string, preferred?: string | null): Promise<string[]> {
    if (preferred) return [preferred];
    const inbox = await runtimeGet<InboxPayload>(this.cfg.serverUrl, "/inbox?probe=1", token, this.cfg.tenantId);
    const ids = new Set<string>();
    for (const row of inbox?.rows ?? []) {
      if (row.conversation_id) ids.add(row.conversation_id);
      if (ids.size >= 5) break;
    }
    return [...ids];
  }

  private async publishEngineFailure(args: { token: string; runId?: string; conversationId?: string | null; error: string; exitCode: number }): Promise<void> {
    await runtimePost(this.cfg.serverUrl, "/events", args.token, {
      runId: args.runId,
      kind: "engine.failed",
      level: "error",
      title: `${this.adapter.id} failed`,
      data: { error: args.error, exitCode: args.exitCode }
    }, this.cfg.tenantId);
    const conversationIds = await this.failureConversationIds(args.token, args.conversationId);
    await Promise.all(
      conversationIds.map((conversationId) =>
        runtimePost(this.cfg.serverUrl, "/notices", args.token, {
          conversationId,
          agentId: this.agent.id,
          noticeKind: "byoa_engine_failed",
          text: `${this.agent.name} could not run on local ${this.adapter.id}: ${args.error}\n${authFailureHint(this.adapter.id, args.error)}`,
          dedupeKey: `byoa_engine_failed:${this.agent.id}:${conversationId}:${hashText(args.error)}`,
          dedupeTtlSec: 900
        }, this.cfg.tenantId)
      )
    );
  }

  private async publishEvent(kind: string, data: Record<string, unknown>, level = "info", title?: string): Promise<void> {
    try {
      const token = await this.ensureToken();
      await runtimePost(this.cfg.serverUrl, "/events", token, {
        kind,
        level,
        title: title ?? kind,
        agentId: this.agent.id,
        engine: this.adapter.id,
        data
      }, this.cfg.tenantId);
    } catch {
      // Events are observability only; never block agent execution on them.
    }
  }

  private async publishBudgetEvent(token: string, runId?: string): Promise<void> {
    const check = checkTokenBudget(this.runStats, tokenBudgetFromEnv());
    if (!check || check.state === "ok") {
      this.lastBudgetEventState = null;
      return;
    }
    if (check.state === this.lastBudgetEventState) return;
    this.lastBudgetEventState = check.state;
    await runtimePost(this.cfg.serverUrl, "/events", token, {
      runId,
      kind: check.exceeded ? "agent.budget_exceeded" : "agent.budget_warning",
      level: check.exceeded ? "error" : "warn",
      title: `${this.agent.name} token budget ${check.state}`,
      agentId: this.agent.id,
      engine: this.adapter.id,
      data: check
    }, this.cfg.tenantId);
  }

  private triageModel(): string {
    return process.env.KING_AI_TRIAGE_MODEL || (this.adapter.id === "claude" ? "haiku" : "gpt-5.4-mini");
  }

  private async recordTriageUsage(token: string, verdict: TriageVerdict, usage: unknown): Promise<void> {
    await runtimePost(this.cfg.serverUrl, "/triage", token, {
      source: `byoa-${this.adapter.id}`,
      model: this.triageModel(),
      actionable: verdict.actionable,
      reason: verdict.reason ?? "",
      responseMode: verdict.responseMode,
      usage: usageForRuntime(usage)
    }, this.cfg.tenantId);
  }

  private async inboxTriage(token: string): Promise<TriageVerdict | null> {
    const payload = await runtimeGet<TriagePayload>(this.cfg.serverUrl, "/inbox-triage/payload", token, this.cfg.tenantId);
    if (!payload) return null;
    if (payload.verdict) return payload.verdict;
    if (!payload.instructions || !payload.input) return null;

    const jitter = Math.floor(Math.random() * TRIAGE_SPAWN_JITTER_MS);
    if (jitter > 0) await new Promise((resolve) => setTimeout(resolve, jitter));
    await triageSem.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRIAGE_TIMEOUT_MS);
    try {
      await mkdir(TRIAGE_DIR, { recursive: true });
      const res = await this.adapter.classify({
        cwd: TRIAGE_DIR,
        prompt: `${payload.instructions}\n\n${payload.input}`,
        env: this.engineEnv(),
        model: process.env.KING_AI_TRIAGE_MODEL,
        signal: controller.signal
      });
      if (res.error || !res.text.trim()) {
        const errText = res.error || "no output";
        if (controller.signal.aborted || isRateLimited(errText)) {
          return { actionable: false, source: "rate-limited", reason: `triage rate-limited (${errText.slice(0, 120)}); backing off` };
        }
        return {
          actionable: true,
          source: "fail-open",
          reason: `local triage failed (${errText.slice(0, 120)}); fail open`,
          promptNote: "Local small-brain triage failed; read the inbox/context yourself and respond only if a human needs you. Do not silently ack unread human messages unless the thread clearly shows they are irrelevant or already handled."
        };
      }
      const parsed = parseTriage(res.text);
      if (parsed) {
        const verdict = { ...parsed, source: "local" };
        void this.recordTriageUsage(token, verdict, res.usage);
        return verdict;
      }
      return {
        actionable: true,
        source: "fail-open",
        reason: "local triage produced no usable verdict; fail open",
        promptNote: "Local small-brain triage gave no clear verdict; read the inbox/context yourself and respond only if a human needs you."
      };
    } finally {
      clearTimeout(timer);
      triageSem.release();
    }
  }

  private async snapshotUnread(token: string): Promise<{ seen: Map<string, string>; digest: string; hasReal: boolean; imagePaths: string[] }> {
    const inbox = await runtimeGetStrict<InboxPayload>(this.cfg.serverUrl, "/inbox", token, this.cfg.tenantId);
    const rows = inbox.rows ?? [];
    const seen = new Map<string, string>();
    const lines: string[] = [];
    const imagePaths: string[] = [];
    let hasReal = false;
    const headered = new Set<string>();
    for (const row of [...rows].sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0))) {
      if (row.conversation_id && row.id) seen.set(row.conversation_id, row.id);
    }
    const routedRows = sortRuntimeMessages(rows, this.agent.id);
    const routeSummary = formatMessageRouteSummary(rows, this.agent.id, 10);
    if (routeSummary) {
      lines.push("Priority route:");
      for (const line of routeSummary.split("\n")) lines.push(`  ${line}`);
    }
    for (const routed of routedRows) {
      const row = routed.row;
      if (!row.conversation_id) continue;
      if (row.kind !== "system") hasReal = true;
      if (!headered.has(row.conversation_id)) {
        headered.add(row.conversation_id);
        lines.push(`# ${row.conversation_id}${row.conversation_title ? ` "${row.conversation_title}"` : ""}`);
      }
      const who = row.author_name ?? "someone";
      const body = row.kind === "system" ? "[system]" : (row.body ?? "").replace(/\s+/g, " ").slice(0, 600);
      lines.push(`  [${row.id ?? "?"}] [${messageRouteTag(routed)}] ${who}: ${body}`);
      const attachments = await cacheLocalAttachments(normalizeRuntimeAttachments(row.attachments));
      for (const attachment of attachments) {
        if (attachment.kind === "image" && attachment.decision === "accepted" && attachment.localPath) imagePaths.push(attachment.localPath);
      }
      const attachmentPrompt = formatAttachmentPrompt(attachments);
      if (attachmentPrompt) {
        for (const line of attachmentPrompt.split("\n")) lines.push(`    ${line}`);
      }
    }
    return { seen, digest: lines.slice(-40).join("\n"), hasReal, imagePaths };
  }

  private async ackSeen(token: string, seen: Map<string, string>): Promise<void> {
    await Promise.all(
      [...seen].map(([conversationId, upToMessageId]) =>
        runtimePostStrict(this.cfg.serverUrl, "/conversation/mark-read", token, { conversationId, upToMessageId }, this.cfg.tenantId)
      )
    );
  }

  private async ackRunActions(token: string, runId: string | undefined, fallbackSeen: Map<string, string>): Promise<boolean> {
    if (!runId) return false;
    const payload = await runtimeGetStrict<RunActionsPayload>(this.cfg.serverUrl, `/runs/${runId}/actions`, token, this.cfg.tenantId);
    const seen = new Map<string, string>();
    for (const action of payload.actions ?? []) {
      if (!action.conversationId) continue;
      const messageId = action.messageId ?? action.requestId ?? fallbackSeen.get(action.conversationId);
      if (messageId) seen.set(action.conversationId, messageId);
    }
    if (!seen.size) return false;
    await this.ackSeen(token, seen);
    return true;
  }

  private async rosterDigest(token: string): Promise<string> {
    const payload = await runtimeGet<{ roster?: string }>(this.cfg.serverUrl, "/roster", token, this.cfg.tenantId);
    return typeof payload?.roster === "string" ? payload.roster.trim().slice(0, 4000) : "";
  }

  private async runtimePreamble(token: string, reason: string, runId?: string, steerReason?: string): Promise<string> {
    const params = new URLSearchParams({
      agent: this.agent.id,
      reason
    });
    if (runId) params.set("runId", runId);
    if (steerReason) params.set("steerReason", steerReason);
    const payload = await runtimeGet<RuntimePreamblePayload>(this.cfg.serverUrl, `/preamble?${params.toString()}`, token, this.cfg.tenantId);
    return typeof payload?.text === "string" ? payload.text.trim().slice(0, 4000) : "";
  }

  private promptForTurn(digest: string, memoryDigest: string, rosterDigest: string, preamble: string, triage?: TriageVerdict | null): string {
    const delta = appendRuntimePreamble(buildChatDelta(digest, memoryDigest, rosterDigest, triage), preamble);
    if (this.engineSession?.carriesStandingPrompt) return delta;
    return `${this.standingPrompt()}

${delta}`;
  }

  private promptForAgenda(brief: string, memoryDigest: string, rosterDigest: string, preamble: string): string {
    const delta = appendRuntimePreamble(buildAgendaDelta(brief, memoryDigest, rosterDigest), preamble);
    if (this.engineSession?.carriesStandingPrompt) return delta;
    return `${this.standingPrompt()}

${delta}`;
  }

  private logEngineLine(line: string): void {
    const display = formatEngineLogLine(this.adapter.id, line);
    if (display) console.log(`[${this.agent.id}/${this.adapter.id}] ${display.slice(0, 500)}`);
  }

  private ensureEngineSession(): EngineSession | null {
    if (this.engineSession && this.engineSession.alive) return this.engineSession;
    const resumeSessionId = this.sessionId;
    this.engineSession = this.adapter.startSession?.({
      home: this.home,
      env: this.engineEnv(),
      model: this.agent.model,
      fastModel: this.agent.fastModel,
      resumeSessionId: this.sessionId,
      standingPrompt: this.standingPrompt(),
      onLog: (line) => this.logEngineLine(line)
    }) ?? null;
    if (this.engineSession) {
      const resumeLabel = resumeSessionId ? `resume ${resumeSessionId.slice(0, 8)}` : "fresh";
      console.log(`[${this.agent.id}/${this.adapter.id}] engine session spawned (${resumeLabel}); persistent mode active`);
      void this.publishEvent("engine.session.started", {
        mode: "persistent",
        resumeSessionId: resumeSessionId ?? null
      });
    }
    return this.engineSession;
  }

  private async runTurn(reason: string): Promise<void> {
    if (this.busy) {
      this.pendingRerun = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.pendingRerun = false;
        if (Date.now() < this.triageBackoffUntil) break;
        if (Date.now() < this.engineBackoffUntil) break;
        const token = await this.ensureToken();
        const activeContract = this.lastWakeContract;
        this.lastWakeContract = null;
        const activeConversationId = activeContract?.conversationId ?? null;
        await this.publishEvent("turn.check", { reason, ...activeContract });
        let snapshot: { seen: Map<string, string>; digest: string; hasReal: boolean; imagePaths: string[] };
        try {
          snapshot = await this.snapshotUnread(token);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.agent.id}/${this.adapter.id}] runtime inbox unavailable: ${message}; backing off without acking unread`);
          await this.publishEvent("runtime.inbox_unavailable", { reason, error: message }, "warn");
          await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
          break;
        }
        const { seen, digest, hasReal, imagePaths } = snapshot;
        if (!hasReal) {
          await this.ackSeen(token, seen);
          await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
          await this.maybeAgendaTurn(token);
          continue;
        }

        const triage = await this.inboxTriage(token);
        if (triage?.source === "rate-limited") {
          this.triageTroubleStreak += 1;
          const backoff = Math.min(TRIAGE_BACKOFF_MAX_MS, 30_000 * 2 ** (this.triageTroubleStreak - 1));
          this.triageBackoffUntil = Date.now() + backoff;
          console.warn(`[${this.agent.id}/${this.adapter.id}] triage rate-limited; backing off ${Math.round(backoff / 1000)}s without acking unread`);
          await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
          break;
        }
        if (triage?.source !== "fail-open") {
          this.triageTroubleStreak = 0;
          this.triageBackoffUntil = 0;
        }
        if (triage?.actionable === false) {
          await this.ackSeen(token, seen);
          await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
          await this.maybeAgendaTurn(token);
          continue;
        }

        await runtimePost(this.cfg.serverUrl, "/status", token, { status: "thinking" }, this.cfg.tenantId);
        let typingTimer: NodeJS.Timeout | null = null;
        const typingConvo = activeConversationId;
        if (typingConvo) {
          const ping = () => {
            void runtimePost(this.cfg.serverUrl, "/typing", token, { conversationId: typingConvo, done: false }, this.cfg.tenantId);
            void runtimePost(this.cfg.serverUrl, "/thinking/mark", token, { conversationIds: [typingConvo], ttlSec: 60 }, this.cfg.tenantId);
          };
          ping();
          typingTimer = setInterval(ping, 6000);
        }
        const run = await runtimePost<RuntimeRun>(this.cfg.serverUrl, "/runs", token, {
          trigger: { source: reason, engine: this.adapter.id },
          contract: {
            ...activeContract,
            agentId: this.agent.id
          }
        }, this.cfg.tenantId);
        this.activeRunId = run?.runId ?? null;
        this.activeRunContract = run?.contract ?? (activeContract ? { ...activeContract, agentId: this.agent.id } : null);
        await this.publishEvent("turn.started", { reason, runId: run?.runId, conversationId: activeConversationId });
        const stopBeat = this.beatRun(token, run?.runId);
        let error: string | undefined;
        let exitCode = 0;
        let turnModel: string | null | undefined;
        let turnUsage: unknown;
        const runStartedAt = Date.now();
        const jitter = Math.floor(Math.random() * BIG_BRAIN_SPAWN_JITTER_MS);
        if (jitter > 0) await new Promise((resolve) => setTimeout(resolve, jitter));
        await bigBrainSem.acquire();
        try {
          const [memory, roster, preamble] = await Promise.all([
            this.memoryDigest(),
            this.rosterDigest(token),
            this.runtimePreamble(token, reason, run?.runId)
          ]);
          const prompt = this.promptForTurn(digest, memory, roster, preamble, triage);
          const controller = new AbortController();
          const resumeSessionId = this.sessionId;
          const session = this.ensureEngineSession();
          const result = session
            ? await session.send(prompt, { imagePaths })
            : await this.adapter.run({
                home: this.home,
                prompt,
                env: this.engineEnv(),
                model: this.agent.model,
                fastModel: this.agent.fastModel,
                resumeSessionId: this.sessionId,
                standingPrompt: this.standingPrompt(),
                imagePaths,
                signal: controller.signal,
                onLog: (line) => this.logEngineLine(line)
              });
          exitCode = result.exitCode;
          turnModel = result.model;
          turnUsage = result.usage;
          if (result.error) this.remediation = engineRemediationAdvice(this.adapter.id, result.error);
          else this.remediation = null;
          this.notifyStateChange();
          error = result.error ? visibleEngineError(this.adapter.id, this.home, exitCode, result.error) : undefined;
          if (result.sessionId) await this.setSessionId(result.sessionId);
          if (session && !session.alive) this.engineSession = null;
          if (error && mustResetSession(error, !!resumeSessionId)) await this.resetEngineSession(sessionResetReason(error));
        } finally {
          bigBrainSem.release();
          stopBeat();
          if (typingTimer) clearInterval(typingTimer);
          if (typingConvo) {
            await runtimePost(this.cfg.serverUrl, "/typing", token, { conversationId: typingConvo, done: true }, this.cfg.tenantId);
            await runtimePost(this.cfg.serverUrl, "/thinking/unmark", token, { conversationIds: [typingConvo] }, this.cfg.tenantId);
          }
        }

        if (error) {
          if (isRateLimited(error)) this.engineBackoffUntil = Date.now() + ENGINE_BACKOFF_MS;
          if (!isRateLimited(error)) {
            await this.publishEngineFailure({ token, runId: run?.runId, conversationId: typingConvo, error, exitCode });
          }
        } else {
          const acked = await this.ackRunActions(token, run?.runId, seen);
          if (!acked) {
            await this.publishEvent("turn.no_state_action", {
              reason,
              runId: run?.runId,
              conversationId: typingConvo,
              messageCount: seen.size
            }, "warn");
          }
        }
        await runtimePost(this.cfg.serverUrl, `/runs/${run?.runId}/finish`, token, {
          status: error ? "failed" : "completed",
          summary: error ?? `local ${this.adapter.id} completed`,
          error,
          exitCode,
          model: turnModel ?? this.agent.model,
          usage: turnUsage ?? null
        }, this.cfg.tenantId);
        const durationMs = Date.now() - runStartedAt;
        this.runStats = recordAgentRunStats(this.runStats, {
          status: error ? "failed" : "completed",
          usage: turnUsage && typeof turnUsage === "object" ? turnUsage : null,
          durationMs,
          model: turnModel ?? this.agent.model ?? null
        });
        this.notifyStateChange();
        await this.publishBudgetEvent(token, run?.runId);
        await this.publishEvent(error ? "turn.failed" : "turn.completed", {
          reason,
          runId: run?.runId,
          conversationId: typingConvo,
          exitCode,
          model: turnModel ?? this.agent.model ?? null,
          usage: turnUsage ?? null,
          durationMs
        }, error ? "error" : "info");
        await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
        this.activeRunId = null;
        this.activeRunContract = null;
        this.lastTurnEndedAt = Date.now();
      } while (this.pendingRerun && !this.stopped);
    } finally {
      this.busy = false;
    }
  }

  private async maybeAgendaTurn(token: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastTurnEndedAt < AGENDA_QUIET_MS) return;
    if (now - this.lastAgendaCheckAt < AGENDA_CHECK_MS) return;
    this.lastAgendaCheckAt = now;
    if (Date.now() < this.engineBackoffUntil) return;
    const agenda = await runtimeGet<AgendaPayload>(this.cfg.serverUrl, "/agenda", token, this.cfg.tenantId);
    if (!agenda?.actionable || !agenda.brief) return;
    console.log(`[${this.agent.id}/${this.adapter.id}] agenda turn START${agenda.focus ? ` ${agenda.focus}` : ""}`);
    await this.publishEvent("agenda.started", { focus: agenda.focus ?? null });
    await runtimePost(this.cfg.serverUrl, "/status", token, { status: "thinking" }, this.cfg.tenantId);
    const run = await runtimePost<RuntimeRun>(this.cfg.serverUrl, "/runs", token, {
      trigger: { source: "agenda", engine: this.adapter.id }
    }, this.cfg.tenantId);
    const stopBeat = this.beatRun(token, run?.runId);
    let error: string | undefined;
    let exitCode = 0;
    let turnModel: string | null | undefined;
    let turnUsage: unknown;
    const runStartedAt = Date.now();
    const jitter = Math.floor(Math.random() * BIG_BRAIN_SPAWN_JITTER_MS);
    if (jitter > 0) await new Promise((resolve) => setTimeout(resolve, jitter));
    await bigBrainSem.acquire();
    try {
      const [memory, roster, preamble] = await Promise.all([
        this.memoryDigest(),
        this.rosterDigest(token),
        this.runtimePreamble(token, "agenda", run?.runId)
      ]);
      const prompt = this.promptForAgenda(agenda.brief, memory, roster, preamble);
      const controller = new AbortController();
      const resumeSessionId = this.sessionId;
      const session = this.ensureEngineSession();
      const result = session
        ? await session.send(prompt)
        : await this.adapter.run({
            home: this.home,
            prompt,
            env: this.engineEnv(),
            model: this.agent.model,
            fastModel: this.agent.fastModel,
            resumeSessionId: this.sessionId,
            standingPrompt: this.standingPrompt(),
            signal: controller.signal,
            onLog: (line) => this.logEngineLine(line)
          });
      exitCode = result.exitCode;
      turnModel = result.model;
      turnUsage = result.usage;
      if (result.error) this.remediation = engineRemediationAdvice(this.adapter.id, result.error);
      else this.remediation = null;
      this.notifyStateChange();
      error = result.error ? visibleEngineError(this.adapter.id, this.home, exitCode, result.error) : undefined;
      if (result.sessionId) await this.setSessionId(result.sessionId);
      if (session && !session.alive) this.engineSession = null;
      if (error && mustResetSession(error, !!resumeSessionId)) await this.resetEngineSession(sessionResetReason(error));
    } finally {
      bigBrainSem.release();
      stopBeat();
    }
    if (error) {
      if (isRateLimited(error)) this.engineBackoffUntil = Date.now() + ENGINE_BACKOFF_MS;
      if (!isRateLimited(error)) {
        await runtimePost(this.cfg.serverUrl, "/events", token, {
          runId: run?.runId,
          kind: "agenda.failed",
          level: "error",
          title: `${this.adapter.id} agenda failed`,
          data: { error }
        }, this.cfg.tenantId);
      }
    }
    await runtimePost(this.cfg.serverUrl, `/runs/${run?.runId}/finish`, token, {
      status: error ? "failed" : "completed",
      summary: error ?? `agenda ${this.adapter.id} completed`,
      error,
      exitCode,
      model: turnModel ?? this.agent.model,
      usage: turnUsage ?? null
    }, this.cfg.tenantId);
    const durationMs = Date.now() - runStartedAt;
    this.runStats = recordAgentRunStats(this.runStats, {
      status: error ? "failed" : "completed",
      usage: turnUsage && typeof turnUsage === "object" ? turnUsage : null,
      durationMs,
      model: turnModel ?? this.agent.model ?? null
    });
    this.notifyStateChange();
    await this.publishBudgetEvent(token, run?.runId);
    await this.publishEvent(error ? "agenda.failed" : "agenda.completed", {
      runId: run?.runId,
      focus: agenda.focus ?? null,
      exitCode,
      model: turnModel ?? this.agent.model ?? null,
      usage: turnUsage ?? null,
      durationMs
    }, error ? "error" : "info");
    await runtimePost(this.cfg.serverUrl, "/status", token, { status: "avail" }, this.cfg.tenantId);
    this.lastTurnEndedAt = Date.now();
  }

  private async streamLoop(): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const token = await this.ensureToken();
        this.wakeStreamController = replaceWakeStreamController(this.wakeStreamController);
        const res = await fetch(`${this.cfg.serverUrl}/runtime/wake-stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", ...tenantHeader(this.cfg.tenantId) },
          signal: this.wakeStreamController.signal
        });
        if (isWakeStreamAuthFailure(res.status)) {
          const message = `wake-stream HTTP ${res.status}`;
          this.token = "";
          this.tokenExpiresAt = 0;
          console.error(`[${this.agent.id}/${this.adapter.id}] ${message}; authentication failed, stopping wake stream`);
          await this.publishEvent("wake.stream.auth_failed", { status: res.status, error: message }, "error");
          break;
        }
        if (!res.ok || !res.body) throw new Error(`wake-stream HTTP ${res.status}`);
        console.log(`[${this.agent.id}/${this.adapter.id}] wake-stream connected`);
        await this.publishEvent("wake.stream.connected", { backoffMs: backoff });
        backoff = 1000;
        this.scheduleWake("reconnect-catchup");
        for await (const evt of parseSseStream(res.body)) {
          if (this.stopped) break;
          if (evt.event !== "wake" && evt.event !== "steer") continue;
          const info = parseWakeEventInfo(evt.data);
          if (!shouldHandleWakeEvent(info, this.agent.id)) continue;
          if (info.resetState) {
            console.log(`[${this.agent.id}/${this.adapter.id}] reset-state wake received; clearing local agent home and engine session`);
            this.handleResetLocalState();
            break;
          }
          const contract: RuntimeRunContract = {
            agentId: this.agent.id,
            conversationId: info.conversationId ?? undefined,
            requestId: info.requestId ?? undefined,
            messageId: info.messageId ?? undefined,
            taskId: info.taskId ?? undefined
          };
          const conversationId = info.conversationId;
          if (evt.event === "steer") {
            if (conversationId) void this.maybeSteer(conversationId);
            else {
              const steerText = evt.data ? `New runtime steering event: ${evt.data}` : "New runtime steering event.";
              this.steerRunningTurn(steerText);
            }
          }
          console.log(
            `[${this.agent.id}/${this.adapter.id}] SSE ${evt.event} received${conversationId ? ` conversation=${conversationId}` : ""}${info.deliveryLatencyMs == null ? "" : ` deliveryLatency=${info.deliveryLatencyMs}ms`}`
          );
          await this.publishEvent("wake.received", {
            event: evt.event,
            ...contract,
            sentAt: info.sentAt,
            deliveryLatencyMs: info.deliveryLatencyMs
          });
          this.scheduleWake(`sse-${evt.event}`, contract);
        }
      } catch (err) {
        if (this.stopped) break;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.agent.id}/${this.adapter.id}] wake-stream error: ${message}; retry in ${backoff}ms`);
        await this.publishEvent("wake.stream.error", { error: message, retryInMs: backoff }, "warn");
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      } finally {
        abortWakeStream(this.wakeStreamController);
        this.wakeStreamController = null;
      }
    }
  }
}

export function abortWakeStream(controller: AbortController | null): void {
  if (controller && !controller.signal.aborted) controller.abort();
}

export function replaceWakeStreamController(controller: AbortController | null): AbortController {
  abortWakeStream(controller);
  return new AbortController();
}

export function isWakeStreamAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}
