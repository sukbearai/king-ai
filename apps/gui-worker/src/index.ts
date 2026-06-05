/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { cors } from "hono/cors";
import { betterAuth } from "better-auth";
import { D1Dialect } from "kysely-d1";
import { render as renderMarkdownHtml } from "@comark/html";
import { renderPage } from "./page.js";
import { cronMatches, parseCron } from "@suwujs/king/cron";
import { formatAttachmentPrompt, normalizeRuntimeAttachments } from "@suwujs/king/attachments";
import type { RuntimeAttachment } from "@suwujs/king/attachments";
import { initialRunStreamState, reduceRunStream, renderRunStreamCard } from "@suwujs/king/run-stream";
import type { RunStreamEvent, RunStreamState } from "@suwujs/king/run-stream";
import { formatMessageRouteSummary, messageRouteTag, sortRuntimeMessages } from "@suwujs/king/message-routing";
import { selectOwnerRole } from "@suwujs/king/team-routing";
import { defaultTeamSpec, requiredCapabilitiesForText, roleTemplateForAgent } from "@suwujs/king/team-workflow";
import { createHostSdk } from "@suwujs/king/host-sdk";

type Bindings = {
  GUI_STATE: DurableObjectNamespace;
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_URL?: string;
  KING_TEST_AUTH_USER?: string;
  KING_HOST_URL?: string;
  KING_HOST_OUTPUT_DIR?: string;
};

type Env = {
  Bindings: Bindings;
};

type Agent = {
  id: string;
  name: string;
  role: string;
  engine?: "claude" | "codex";
  lifecycle?: "on-demand" | "24/7" | "idle_cached" | "disabled";
  model?: string;
  fastModel?: string;
  events?: string[];
};

type AgentLifecycle = NonNullable<Agent["lifecycle"]>;

type AgentStateSummary = {
  id: string;
  name: string;
  role: string;
  engine: string;
  lifecycle: AgentLifecycle;
  status: string;
  model: string;
  fastModel: string;
  unreadMessages: number;
  openClaims: number;
  activeCards: number;
  openTasks: number;
  blockedTasks: number;
  lastStatusAt?: number;
};

type Message = {
  id: string;
  conversation_id: string;
  conversation_title: string;
  conversation_kind: "direct" | "group";
  author_name: string;
  author_kind: "human" | "agent" | "system";
  author_engine?: Agent["engine"];
  status?: "pending" | "done";
  kind: "message" | "system";
  body: string;
  body_html?: string;
  priority?: "normal" | "steer";
  message_type?: "message" | "decision" | "blocker";
  to_agent_id?: string;
  quoted_message_id?: string;
  payload?: unknown;
  attachments?: RuntimeAttachment[];
  created_at: number;
  readBy: string[];
};

type UploadedAttachment = {
  id: string;
  token: string;
  name: string;
  mime: string;
  size: number;
  bytesBase64?: string;
  chunkCount?: number;
  createdAt: number;
};

type Conversation = {
  id: string;
  title: string;
  kind: "direct" | "group";
  created_at: number;
  updated_at: number;
  order?: number;
  teamMode?: "single" | "team" | "custom";
  coordinatorAgentId?: string;
  teamAgentIds?: string[];
  teamSnapshot?: ConversationTeamSnapshot;
};

type ConversationAgentSnapshot = Agent;

type ConversationTeamSnapshot = {
  mode: NonNullable<Conversation["teamMode"]>;
  coordinatorAgentId: string;
  teamAgentIds: string[];
  agents: ConversationAgentSnapshot[];
  createdAt: number;
};

type EventRoute = {
  eventType: string;
  agentId: string;
  createdAt: number;
};

type ExternalEvent = {
  type: string;
  source: string;
  payload: unknown;
  timestamp: number;
};

type Card = {
  id: string;
  title: string;
  column: "todo" | "doing" | "done";
  assignee?: string;
  claimedBy?: string;
  allowedPaths?: string[];
  created_at: number;
};

type TaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed" | "blocked";
type TaskReviewResult = "approved" | "changes_requested";
type TaskEventType = "assigned" | "submitted_for_review" | "completed" | "changes_requested";
type CapsuleStatus = "open" | "in_review" | "merged" | "abandoned";
type CapsuleScopeType = "code" | "docs" | "tests" | "ops" | "mixed";
type MergeStatus = "queued" | "testing" | "merged" | "conflict" | "failed";

type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
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
  reviewResult?: TaskReviewResult;
  revisionReason?: string;
  artifactIds?: string[];
  reviewedByAgentId?: string;
  reviewedAt?: number;
  created_at: number;
  updated_at: number;
};

type TaskEvent = {
  id: string;
  taskId: string;
  type: TaskEventType;
  conversationId?: string;
  actorAgentId?: string;
  targetAgentId?: string;
  summary: string;
  result?: string;
  reviewResult?: TaskReviewResult;
  revisionReason?: string;
  artifactIds?: string[];
  created_at: number;
};

type InitiativeStatus = "active" | "paused" | "completed" | "abandoned";

type Initiative = {
  id: string;
  title: string;
  goal: string;
  summary?: string;
  status: InitiativeStatus;
  priority: number;
  sources?: string[];
  agentId: string;
  created_at: number;
  updated_at: number;
};

type ChangeCapsule = {
  id: string;
  goal: string;
  ownerAgent: string;
  branch: string;
  baseCommit: string;
  allowedPaths: string[];
  acceptance: string;
  reviewer?: string;
  status: CapsuleStatus;
  initiativeId?: string;
  taskId?: string;
  subsystem?: string;
  scopeType?: CapsuleScopeType;
  blockedBy?: string[];
  supersedes?: string;
  created_at: number;
  updated_at: number;
};

type MergeRequest = {
  id: string;
  taskId?: string;
  capsuleId?: string;
  branch: string;
  agentId: string;
  targetBranch: string;
  status: MergeStatus;
  createdAt: number;
  updatedAt: number;
  mergedAt?: number;
  error?: string;
};

type EvaluationCriteria = {
  name: string;
  weight: number;
  description?: string;
};

type EvaluationScore = {
  optionId: string;
  scores: Record<string, number>;
  totalScore: number;
  reasoning: string;
};

type EvaluationRecord = {
  id: string;
  scores: EvaluationScore[];
  selectedOptionId: string;
  confidence: number;
  tokensUsed: number;
  requiresHumanApproval: boolean;
  criteria: EvaluationCriteria[];
  artifactId?: string;
  initiativeId?: string;
  createdAt: number;
};

type RunFeedback = {
  id: string;
  runId?: string;
  agentId: string;
  taskId?: string;
  executionProfile?: string;
  taskCompleted: boolean;
  durationMs: number;
  tokenCount: number;
  errored: boolean;
  humanIntervention: boolean;
  steerCount: number;
  loopNumber?: number;
  acceptedByCeo?: boolean;
  acceptedByUser?: boolean;
  revisionCount: number;
  outputQualityScore?: number;
  artifactReused?: boolean;
  artifactLookupSuccess?: boolean;
  createdAt: number;
};

type ReviewDecision = "approved" | "changes_requested";

type ReviewRecord = {
  id: string;
  capsuleId: string;
  mergeId?: string;
  reviewer: string;
  coveragePct: number;
  checksPassed: boolean;
  acceptanceMet: boolean;
  scopeMatched: boolean;
  testsMeaningful: boolean;
  noRegressions: boolean;
  decision: ReviewDecision;
  reasons: string[];
  comment?: string;
  createdAt: number;
};

type CalendarItem = {
  id: string;
  title: string;
  at: string;
  cron?: string;
  assignee?: string;
  prompt?: string;
  created_at: number;
};

type Claim = {
  id: string;
  name: string;
  conversationId?: string;
  owner: string;
  allowedPaths?: string[];
  created_at: number;
};

type Doc = {
  id: string;
  title: string;
  body: string;
  created_at: number;
};

type Artifact = {
  id: string;
  kind: string;
  path: string;
  source: string;
  confidence: number;
  agentId: string;
  taskId?: string;
  content?: string;
  metadata: Record<string, unknown>;
  verified: boolean;
  created_at: number;
};

type ArtifactQualityCheck = {
  valid: boolean;
  warnings: string[];
  score: number;
};

type ContextEntry = {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
};

type HypothesisStatus = "proposed" | "active" | "validated" | "rejected" | "abandoned";

type Hypothesis = {
  id: string;
  title: string;
  status: HypothesisStatus;
  agentId: string;
  parentId?: string;
  rationale?: string;
  expectedValue?: string;
  estimatedCost?: string;
  outcome?: string;
  evidenceArtifactIds?: string[];
  created_at: number;
  updated_at: number;
};

type Reaction = {
  messageId: string;
  emoji: string;
  authorId: string;
  created_at: number;
};

type ComposingClaim = {
  conversationId: string;
  agentId: string;
  agentName: string;
  claimed_at: number;
  expires_at: number;
};

type LoopClassification = "productive" | "idle" | "blocked" | "backlog_stuck" | "error";

type LoopEventType =
  | "loop.tick"
  | "loop.classified"
  | "agent.spawned"
  | "task.transition"
  | "task.blocked"
  | "queue.backlog"
  | "artifact.created"
  | "agent.budget_exceeded";

type LoopEvent = {
  type: LoopEventType;
  runId: string;
  loop: number;
  timestamp: string;
  agent?: string;
  taskId?: string;
  from?: string;
  to?: string;
  waitingOn?: string[];
  pendingMessages?: number;
  kind?: string;
  path?: string;
  tokens?: number;
  budget?: number;
  classification?: LoopClassification;
  reasons?: string[];
  payload?: unknown;
};

type LoopSnapshot = {
  runId?: string;
  loop?: number;
  classification: LoopClassification;
  reasons: string[];
  counts: {
    unreadMessages: number;
    blockedTasks: number;
    activeTasks: number;
    openCapsules: number;
    inReviewCapsules: number;
    artifacts: number;
    failedRuns: number;
  };
  recentEvents?: LoopEvent[];
};

type SafetyAction =
  | "git_commit"
  | "git_merge_staging"
  | "git_merge_production"
  | "deploy_staging"
  | "deploy_production"
  | "send_email"
  | "send_slack"
  | "financial_transaction"
  | "delete_data"
  | "modify_permissions";

type ApprovalStatus = "pending" | "approved" | "denied";

type ApprovalRequest = {
  id: string;
  action: SafetyAction;
  context: Record<string, unknown>;
  status: ApprovalStatus;
  conversationId?: string;
  taskId?: string;
  createdAt: number;
  resolvedAt?: number;
  reason?: string;
};

type RemoteAssistGrant = {
  tokenHash: string;
  tokenPreview: string;
  createdAt: number;
  createdBy?: string;
  revokedAt?: number;
  lastUsedAt?: number;
  uses?: number;
};

type PlannedTask = {
  title: string;
  description: string;
  scope: { paths: string[]; patterns?: string[] };
  dependencies: string[];
  estimatedTokens: number;
  priority: number;
};

type ExecutionPlan = {
  optionId: string;
  tasks: PlannedTask[];
  totalEstimatedTokens: number;
};

type State = {
  computerId: string;
  deviceToken: string;
  runtimeToken: string;
  runtimeTokens?: Record<string, string>;
  pairingCode: string;
  availableEngines: string[];
  capabilities: { workspaces: string[]; agentWorkspaceRoot?: string };
  lastHeartbeat?: { at: number; version?: string; capabilities?: { workspaces: string[]; agentWorkspaceRoot?: string } };
  agentConfigUpdatedAt?: number;
  agents: Agent[];
  conversations: Conversation[];
  messages: Message[];
  cliLog: { at: number; agentId: string; argv: string[]; result: string }[];
  statusLog: { at: number; status: string; agentId?: string }[];
  typingLog: { at: number; conversationId?: string; done?: boolean }[];
  thinkingLog: { at: number; action: "mark" | "unmark"; conversationIds: string[] }[];
  eventLog: { at: number; body: unknown }[];
  wakeLog?: { at: number; event: string; data: unknown }[];
  eventRoutes: EventRoute[];
  loopRunId: string;
  currentLoop: number;
  loopEvents: LoopEvent[];
  noticeLog: { at: number; body: unknown }[];
  triageLog: { at: number; body: unknown }[];
  runLog: { at: number; runId: string; action: "start" | "heartbeat" | "finish" | "stream"; body?: unknown; card?: unknown }[];
  runStreams?: Record<string, RunStreamState>;
  initiatives: Initiative[];
  tasks: Task[];
  taskEvents: TaskEvent[];
  capsules: ChangeCapsule[];
  mergeQueue: MergeRequest[];
  evaluations: EvaluationRecord[];
  runFeedback: RunFeedback[];
  reviews: ReviewRecord[];
  cards: Card[];
  calendar: CalendarItem[];
  claims: Claim[];
  docs: Doc[];
  artifacts: Artifact[];
  context: ContextEntry[];
  hypotheses: Hypothesis[];
  reactions: Reaction[];
  composing: ComposingClaim[];
  approvals: ApprovalRequest[];
  uploads?: Record<string, UploadedAttachment>;
  remoteAssist?: RemoteAssistGrant;
};

type StateSnapshot = {
  schema: "king.gui-state.v1";
  exportedAt: number;
  state: State;
};

type PairPayload = {
  code?: unknown;
  engines?: unknown;
  capabilities?: unknown;
};

type AgentConfigPayload = {
  name?: unknown;
  role?: unknown;
  engine?: unknown;
  model?: unknown;
  fastModel?: unknown;
  lifecycle?: unknown;
};

type GuiTaskPayload = {
  title?: unknown;
  description?: unknown;
  assignee?: unknown;
  ownerRole?: unknown;
  reviewerRole?: unknown;
  priority?: unknown;
  paths?: unknown;
  dependsOn?: unknown;
  blockedBy?: unknown;
  acceptance?: unknown;
  wake?: unknown;
};

type GuiTaskUpdatePayload = {
  status?: unknown;
  assignee?: unknown;
  ownerRole?: unknown;
  reviewerRole?: unknown;
  blockedBy?: unknown;
  acceptance?: unknown;
  result?: unknown;
  reviewResult?: unknown;
  revisionReason?: unknown;
  artifactIds?: unknown;
};

type GuiConversationPayload = {
  title?: unknown;
  teamMode?: unknown;
  coordinatorAgentId?: unknown;
  teamAgentIds?: unknown;
  agentRoles?: unknown;
};

type GuiCardMovePayload = {
  column?: unknown;
  owner?: unknown;
};

type AgendaPayload = {
  actionable?: boolean;
  brief?: string;
  focus?: string;
};

const DEFAULT_AGENT: Agent = {
  id: "king-ceo",
  name: "King CEO",
  role: "Coordinate the conversation: clarify ambiguous human requests, split work into concrete tasks for available teammates, track progress, and summarize verified results back to the human. Role template: planner.",
  engine: "codex",
  lifecycle: "on-demand"
};

const DEFAULT_TEAM_AGENTS: Agent[] = [
  DEFAULT_AGENT,
  {
    id: "dev",
    name: "Dev",
    role: "Implement only assigned tasks. Make concrete changes, run focused verification, report files changed and command results, then mark the task done so it can be reviewed or returned to King CEO. Role template: builder.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Review completed Dev work before King CEO summarizes. Check correctness, regressions, and missing tests; pass verified work back to King CEO or request specific revisions. Role template: reviewer.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "tester",
    name: "Tester",
    role: "Role template: tester. Run verification and regression checks, record commands, and surface release-readiness risk.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "ops",
    name: "Ops",
    role: "Role template: ops. Handle queues, release, environment, approval, and audit-sensitive work.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Role template: researcher. Collect evidence, compare options, and produce sourced artifacts with confidence.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "doc-writer",
    name: "Doc Writer",
    role: "Role template: doc-writer. Write verified briefs, documentation, release notes, and user-facing summaries.",
    engine: "codex",
    lifecycle: "on-demand"
  }
];

const LEGACY_DEFAULT_AGENT_NAME = "King Agent";
const LEGACY_DEFAULT_AGENT_ROLE = "Local BYOA agent";
const LEGACY_DEFAULT_AGENT_ID = "king-agent";
const LEGACY_DEFAULT_DEV_ROLE = "Implement assigned work, report concrete changes, and move completed tasks to review.";
const LEGACY_DEFAULT_REVIEWER_ROLE = "Review completed work, identify gaps, and ask for revisions before CEO summarizes.";

const DEFAULT_CONVERSATION: Conversation = {
  id: "king-convo",
  title: "all",
  kind: "group",
  created_at: 0,
  updated_at: 0
};

const STANDARD_ARTIFACT_KINDS = new Set([
  "competitor",
  "market_data",
  "customer_profile",
  "location_data",
  "budget_item",
  "revenue_forecast",
  "financial_summary",
  "brand_asset",
  "content_plan",
  "tech_spec"
]);

const SAFETY_ACTIONS = new Set<SafetyAction>([
  "git_commit",
  "git_merge_staging",
  "git_merge_production",
  "deploy_staging",
  "deploy_production",
  "send_email",
  "send_slack",
  "financial_transaction",
  "delete_data",
  "modify_permissions"
]);

const SAFETY_AUTO_ALLOW = new Set<SafetyAction>([
  "git_commit",
  "git_merge_staging"
]);

const DEFAULT_EVALUATION_CRITERIA: EvaluationCriteria[] = [
  { name: "feasibility", weight: 0.3, description: "Can this option be executed with available context and tools?" },
  { name: "risk", weight: 0.25, description: "Higher means safer and less likely to cause regressions." },
  { name: "impact", weight: 0.25, description: "Expected value if this option succeeds." },
  { name: "cost", weight: 0.2, description: "Higher means cheaper in time, tokens, and operational complexity." }
];

const REVIEW_COVERAGE_GATE = 95;
const LOOP_EVENT_BUFFER_CAPACITY = 100;

// Append-only signal/activity logs are bounded so the single persisted State value
// cannot grow without limit (it is fully (de)serialized on every Durable Object request
// and is subject to the storage value size limit). High-frequency, ephemeral signals
// (typing/thinking/status) keep a short window; activity logs keep a longer tail.
const WAKE_LOG_CAPACITY = 50;
const STATUS_LOG_CAPACITY = 200;
const TYPING_LOG_CAPACITY = 200;
const THINKING_LOG_CAPACITY = 200;
const EVENT_LOG_CAPACITY = 500;
const RUN_LOG_CAPACITY = 500;
const CLI_LOG_CAPACITY = 500;
const NOTICE_LOG_CAPACITY = 200;
const TRIAGE_LOG_CAPACITY = 200;
const GUI_ATTACHMENT_MAX_COUNT = 10;
const GUI_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const GUI_ATTACHMENT_STORE_CAPACITY = 50;
const GUI_ATTACHMENT_CHUNK_CHARS = 256 * 1024;

const styles = "    :root {\n      --accent: #ffd633;\n      --rail: #ffd83d;\n      --sidebar: #fbf4e6;\n      --active: #f15b93;\n      --canvas: #ffffff;\n      --panel: #fffaf0;\n      --line: #111111;\n      --soft-line: #d7d1c5;\n      --ink: #171717;\n      --body: #303030;\n      --muted: #7d7a73;\n      --avatar: #c8b6ff;\n      --shadow: rgba(17,17,17,0.16) 0 14px 36px;\n    }\n    * { box-sizing: border-box; }\n    body {\n      margin: 0;\n      background: var(--canvas);\n      color: var(--ink);\n      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n      font-size: 12px;\n      line-height: 1.35;\n      overflow: hidden;\n    }\n    h1, h2, h3, p { margin: 0; }\n    h1 { font-size: 17px; line-height: 1.1; }\n    h2 { font-size: 15px; line-height: 1.2; }\n    h3 { font-size: 13px; line-height: 1.2; }\n    p { color: var(--body); }\n    button, textarea, select, input { font: inherit; }\n    * {\n      scrollbar-width: thin;\n      scrollbar-color: var(--line) var(--accent);\n    }\n    *::-webkit-scrollbar {\n      width: 13px;\n      height: 13px;\n    }\n    *::-webkit-scrollbar-track {\n      background: var(--accent);\n      border-left: 1px solid var(--line);\n    }\n    *::-webkit-scrollbar-thumb {\n      background: var(--line);\n      border: 3px solid var(--accent);\n    }\n    *::-webkit-scrollbar-corner { background: var(--accent); }\n    button {\n      min-height: 27px;\n      border: 1px solid var(--line);\n      border-radius: 0;\n      padding: 4px 9px;\n      background: var(--canvas);\n      color: var(--ink);\n      font-weight: 800;\n      cursor: pointer;\n    }\n    button:hover, button.primary { background: var(--accent); }\n    button.icon {\n      width: 27px;\n      min-width: 27px;\n      padding: 0;\n      display: grid;\n      place-items: center;\n    }\n    textarea, input, select {\n      width: 100%;\n      border: 1px solid var(--line);\n      border-radius: 0;\n      background: var(--canvas);\n      color: var(--ink);\n      padding: 8px;\n    }\n    textarea {\n      min-height: 54px;\n      resize: vertical;\n      line-height: 1.45;\n    }\n    label {\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n      text-transform: uppercase;\n    }\n    .app {\n      height: 100vh;\n      min-height: 100vh;\n      display: grid;\n      grid-template-columns: 42px 180px minmax(0, 1fr);\n      background: var(--canvas);\n    }\n    .rail {\n      display: grid;\n      grid-template-rows: auto 1fr;\n      gap: 12px;\n      border-right: 2px solid var(--line);\n      background: var(--rail);\n      padding: 8px 6px;\n    }\n    .logo {\n      width: 27px;\n      display: grid;\n      grid-template-columns: 1fr;\n      gap: 6px;\n    }\n    .logo span {\n      width: 27px;\n      height: 27px;\n      display: grid;\n      place-items: center;\n      background: var(--line);\n      color: var(--accent);\n      font-size: 10px;\n      font-weight: 900;\n    }\n    .rail .icon { background: transparent; border-color: transparent; }\n    .rail .icon.active { background: var(--canvas); border-color: var(--line); }\n    .windows {\n      min-width: 0;\n      border-right: 2px solid var(--line);\n      background: var(--sidebar);\n      padding: 8px 6px;\n      overflow: hidden;\n      display: grid;\n      grid-template-rows: auto minmax(0, 1fr);\n      gap: 8px;\n    }\n    .windows-head {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 8px;\n      padding: 0 2px 8px;\n      border-bottom: 1px solid var(--soft-line);\n      font-weight: 900;\n    }\n    .window-list {\n      min-height: 0;\n      overflow: auto;\n      display: grid;\n      align-content: start;\n      gap: 5px;\n    }\n    .window-item {\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto auto;\n      gap: 6px;\n      align-items: center;\n      min-height: 32px;\n      padding: 5px 6px;\n      border: 1px solid transparent;\n      background: transparent;\n      text-align: left;\n      font-weight: 800;\n    }\n    .window-select {\n      min-width: 0;\n      min-height: 0;\n      padding: 0;\n      border: 0;\n      background: transparent;\n      text-align: left;\n      font-weight: 900;\n    }\n    .window-item.active {\n      border-color: var(--line);\n      background: var(--active);\n    }\n    .window-delete {\n      width: 18px;\n      min-width: 18px;\n      min-height: 18px;\n      padding: 0;\n      border-color: var(--line);\n      background: var(--canvas);\n      color: var(--line);\n      line-height: 1;\n    }\n    .window-delete:hover { background: var(--accent); }\n    .window-name {\n      overflow: hidden;\n      text-overflow: ellipsis;\n      white-space: nowrap;\n    }\n    .window-meta {\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n    }\n    .sidebar {\n      display: none;\n      min-width: 0;\n      border-right: 2px solid var(--line);\n      background: var(--sidebar);\n      padding: 9px 5px;\n      overflow: hidden;\n    }\n    .side-title {\n      display: flex;\n      justify-content: space-between;\n      align-items: center;\n      padding: 0 4px 11px;\n      border-bottom: 1px solid var(--soft-line);\n      margin-bottom: 8px;\n    }\n    .side-section { display: grid; gap: 3px; margin: 12px 0; }\n    .side-label {\n      padding: 0 7px;\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n      letter-spacing: 0.03em;\n      text-transform: uppercase;\n    }\n    .side-link, .channel {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 8px;\n      min-height: 25px;\n      padding: 4px 6px;\n      border: 1px solid transparent;\n      color: var(--body);\n      text-decoration: none;\n      white-space: nowrap;\n      overflow: hidden;\n    }\n    .channel.active {\n      background: var(--active);\n      border-color: var(--line);\n      color: var(--line);\n      font-weight: 900;\n    }\n    .badge { color: var(--muted); font-size: 10px; font-weight: 900; }\n    .main {\n      min-width: 0;\n      min-height: 0;\n      height: 100vh;\n      display: grid;\n      grid-template-rows: auto auto minmax(0, 1fr);\n    }\n    .topbar {\n      height: 38px;\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 14px;\n      border-bottom: 2px solid var(--line);\n      padding: 6px 12px;\n    }\n    .channel-head {\n      display: grid;\n      grid-template-columns: 21px minmax(0, auto);\n      gap: 8px;\n      align-items: center;\n      min-width: 0;\n    }\n    .hash {\n      width: 21px;\n      height: 21px;\n      display: grid;\n      place-items: center;\n      background: var(--accent);\n      border: 1px solid var(--line);\n      font-weight: 900;\n    }\n    .channel-name { font-weight: 900; line-height: 1; }\n    .channel-desc {\n      color: var(--muted);\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 10px;\n      overflow: hidden;\n      text-overflow: ellipsis;\n      white-space: nowrap;\n    }\n    .top-actions { display: flex; gap: 6px; }\n    .tabs {\n      height: 24px;\n      display: flex;\n      align-items: stretch;\n      border-bottom: 2px solid var(--line);\n    }\n    .tab {\n      min-height: 0;\n      padding: 3px 12px;\n      border-width: 0 1px 0 0;\n      background: var(--canvas);\n      font-size: 11px;\n    }\n    .tab.active { background: var(--accent); }\n    .workspace {\n      min-height: 0;\n      overflow: auto;\n      background: var(--canvas);\n    }\n    .panel { display: none; min-height: 100%; }\n    .panel.active { display: block; }\n    .chat-panel {\n      position: relative;\n      min-height: 100%;\n      padding: 14px 0 124px;\n    }\n    .message-list {\n      display: grid;\n      gap: 11px;\n      width: 100%;\n      padding: 0 18px;\n    }\n    .system-line {\n      color: #aaa49a;\n      font-size: 10px;\n      text-align: center;\n      padding: 4px 0;\n    }\n    .post {\n      display: grid;\n      grid-template-columns: 24px minmax(0, 1fr);\n      gap: 8px;\n      padding: 8px;\n      border: 1px solid transparent;\n    }\n    .post.highlight { border-color: var(--line); }\n    .avatar {\n      width: 22px;\n      height: 22px;\n      display: grid;\n      place-items: center;\n      border: 1px solid var(--line);\n      background: var(--avatar);\n      color: var(--line);\n      font-size: 12px;\n      font-weight: 900;\n    }\n    .post-top {\n      display: flex;\n      align-items: baseline;\n      gap: 6px;\n      min-width: 0;\n      margin-bottom: 3px;\n    }\n    .author { font-weight: 900; }\n    .time { color: var(--muted); font-size: 10px; white-space: nowrap; }\n    .post-body {\n      color: var(--body);\n      line-height: 1.45;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .jump {\n      position: sticky;\n      bottom: 104px;\n      display: none;\n      width: max-content;\n      margin: 16px auto;\n      box-shadow: var(--shadow);\n    }\n    .jump.visible { display: block; }\n    .composer {\n      position: fixed;\n      right: 16px;\n      bottom: 14px;\n      left: 238px;\n      z-index: 5;\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto;\n      gap: 8px;\n      width: auto;\n      max-width: none;\n      border: 2px solid var(--line);\n      background: var(--canvas);\n      padding: 8px;\n    }\n    .composer textarea {\n      min-height: 44px;\n      max-height: 110px;\n      border: 0;\n      padding: 6px;\n    }\n    .composer button:disabled {\n      opacity: 0.62;\n      cursor: wait;\n    }\n    .tab-panel {\n      max-width: 920px;\n      padding: 18px;\n      gap: 10px;\n    }\n    .tab-panel.active { display: grid; }\n    .task-row {\n      display: grid;\n      gap: 5px;\n      max-width: 720px;\n      border: 1px solid var(--line);\n      padding: 10px;\n    }\n    .task-top {\n      display: flex;\n      align-items: baseline;\n      justify-content: space-between;\n      gap: 10px;\n    }\n    .model-grid { display: grid; gap: 10px; }\n    .model-row {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 12px;\n      border-top: 1px solid var(--soft-line);\n      padding-top: 8px;\n      color: var(--body);\n    }\n    .model-row:first-child { border-top: 0; padding-top: 0; }\n    .available { color: #cc2f68; font-weight: 900; }\n    .unavailable { color: var(--muted); }\n    .cmd {\n      border: 1px solid var(--line);\n      background: var(--panel);\n      padding: 10px;\n      color: var(--body);\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 11px;\n      line-height: 1.5;\n      overflow: auto;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .side-card {\n      display: grid;\n      gap: 10px;\n      border: 1px solid var(--line);\n      padding: 10px;\n    }\n    .settings-actions {\n      display: flex;\n      justify-content: flex-end;\n      gap: 8px;\n    }\n    .field { display: grid; gap: 5px; }\n    .muted { color: var(--muted); font-size: 11px; }\n    dialog {\n      width: min(520px, calc(100vw - 24px));\n      max-height: min(760px, calc(100vh - 24px));\n      border: 2px solid var(--line);\n      border-radius: 0;\n      padding: 0;\n      box-shadow: var(--shadow);\n      overflow: hidden;\n    }\n    dialog::backdrop { background: rgba(0,0,0,0.48); }\n    .computer-dialog { width: min(680px, calc(100vw - 24px)); }\n    .window-dialog { width: min(440px, calc(100vw - 24px)); }\n    .modal-form { margin: 0; }\n    .modal-head {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 16px;\n      padding: 12px;\n      border-bottom: 2px solid var(--line);\n    }\n    .modal-body {\n      display: grid;\n      gap: 12px;\n      padding: 12px;\n      overflow: auto;\n      max-height: calc(100vh - 120px);\n    }\n    .computer-flow {\n      display: grid;\n      gap: 20px;\n      padding: 32px;\n    }\n    .computer-kicker {\n      color: var(--muted);\n      font-size: 11px;\n      font-weight: 900;\n      letter-spacing: 0.14em;\n      text-transform: uppercase;\n    }\n    .computer-title {\n      font-size: 20px;\n      line-height: 1.15;\n      text-transform: uppercase;\n    }\n    .computer-lead {\n      display: grid;\n      grid-template-columns: 36px minmax(0, 1fr);\n      gap: 14px;\n      align-items: start;\n      color: var(--body);\n      font-size: 15px;\n      line-height: 1.5;\n    }\n    .computer-icon {\n      width: 32px;\n      height: 32px;\n      display: grid;\n      place-items: center;\n      border: 2px solid var(--line);\n      background: var(--accent);\n      font-weight: 900;\n    }\n    .computer-muted {\n      margin-top: 8px;\n      color: var(--muted);\n      font-size: 12px;\n      line-height: 1.45;\n    }\n    .computer-rule { border-top: 2px solid var(--soft-line); }\n    .computer-actions {\n      display: flex;\n      align-items: center;\n      justify-content: flex-end;\n      gap: 12px;\n      flex-wrap: wrap;\n    }\n    .computer-actions.between { justify-content: space-between; }\n    .check-row {\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      font-weight: 800;\n      color: var(--body);\n    }\n    .check-row input {\n      width: 16px;\n      height: 16px;\n      padding: 0;\n      accent-color: var(--accent);\n    }\n    .choice-grid {\n      display: grid;\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n      gap: 10px;\n    }\n    .computer-choice {\n      display: grid;\n      grid-template-columns: 28px minmax(0, 1fr);\n      gap: 10px;\n      min-height: 82px;\n      border: 2px solid var(--line);\n      padding: 14px;\n      background: var(--canvas);\n      text-align: left;\n    }\n    .computer-choice.active { background: var(--accent); }\n    .computer-choice.disabled {\n      border-style: dashed;\n      color: var(--muted);\n      opacity: 0.56;\n      cursor: default;\n    }\n    .computer-choice-title {\n      display: block;\n      font-size: 14px;\n      text-transform: uppercase;\n    }\n    .connect-row {\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto;\n      gap: 10px;\n      align-items: center;\n    }\n    .connect-stack {\n      display: grid;\n      gap: 8px;\n      min-width: 0;\n    }\n    .connect-help {\n      color: var(--body);\n      font-size: 12px;\n      font-weight: 900;\n    }\n    .connect-command {\n      border: 2px solid var(--line);\n      background: #080808;\n      color: #a7d66d;\n      padding: 14px;\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 12px;\n      line-height: 1.5;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .connect-status {\n      display: flex;\n      align-items: center;\n      gap: 10px;\n      border: 2px solid var(--line);\n      background: #fff3c4;\n      padding: 14px;\n      font-weight: 900;\n    }\n    .status-dot {\n      width: 10px;\n      height: 10px;\n      border: 2px solid var(--line);\n      border-radius: 50%;\n      background: #ffad7a;\n    }\n    .status-dot.online { background: #74d67b; }\n    .button-shadow { box-shadow: 4px 5px 0 var(--line); }\n    button.primary-pink {\n      background: var(--active);\n      min-height: 36px;\n      padding: 8px 14px;\n      font-size: 14px;\n    }\n    button.disabled-action {\n      background: #edf5df;\n      color: var(--muted);\n      cursor: default;\n    }\n    @media (max-width: 760px) {\n      .app { grid-template-columns: 36px 132px minmax(0, 1fr); }\n      .logo {\n        width: 24px;\n        grid-template-columns: 1fr;\n      }\n      .logo span {\n        width: 22px;\n        height: 16px;\n        font-size: 10px;\n      }\n      .message-list { padding: 0 10px; }\n      .composer { left: 178px; right: 10px; width: auto; }\n      .top-actions .hide-mobile { display: none; }\n      .post { max-width: 100%; }\n      .computer-flow { padding: 22px; }\n      .choice-grid, .connect-row { grid-template-columns: 1fr; }\n    }\n";

const clientScript = "const base = location.origin;\nlet pairCommand = '';\nlet pairCommandPrimary = '';\nlet pairCommandStart = '';\nlet computerStep = 'intro';\nlet lastConnection = { paired: false, online: false };\nlet promptedForComputer = false;\nlet visibleMessageCount = 20;\nlet lastMessageTotal = 0;\nlet loadingOlderMessages = false;\nlet sendingMessage = false;\nlet shouldStickToBottom = true;\nlet activeConversationId = localStorage.getItem('king:activeConversationId') || 'king-convo';\n\nfunction escapeHtml(value) {\n  return String(value ?? '').replace(/[&<>\"']/g, function(ch) {\n    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[ch];\n  });\n}\nfunction formatTime(value) {\n  if (!value) return '未收到';\n  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });\n}\nfunction lifecycleLabel(value) {\n  return ({ 'on-demand': '按需启动', '24/7': '持续在线', idle_cached: '空闲保活', disabled: '停用' })[value] || value || '按需启动';\n}\nfunction taskStatusLabel(value) {\n  return ({ pending: '待分配', assigned: '已分配', in_progress: '进行中', review: '待评审', done: '已完成', failed: '失败', blocked: '被阻塞' })[value] || value || '未知';\n}\nfunction reasonLabel(reason) {\n  return String(reason || '')\n    .replace(/(\\\\\\\\d+) unread message\\\\\\\\(s\\\\\\\\) pending/g, '$1 条消息等待本地 AI 处理')\n    .replace(/(\\\\\\\\d+) failed run\\\\\\\\(s\\\\\\\\)/g, '$1 次运行失败')\n    .replace('no state changes detected', '等待下一条消息。');\n}\nasync function request(path, options) {\n  const res = await fetch(path, options);\n  if (!res.ok) throw new Error(await res.text());\n  return res.headers.get('Content-Type') && res.headers.get('Content-Type').includes('application/json') ? res.json() : res.text();\n}\nfunction openSettings() {\n  document.getElementById('settingsDialog').showModal();\n}\nfunction closeSettings() {\n  document.getElementById('settingsDialog').close();\n}\nfunction closeComputerDialog() {\n  document.getElementById('computerDialog').close();\n}\nasync function openComputerFlow(step) {\n  computerStep = step || 'intro';\n  const settings = document.getElementById('settingsDialog');\n  if (settings.open) settings.close();\n  renderComputerFlow();\n  const dialog = document.getElementById('computerDialog');\n  if (!dialog.open) dialog.showModal();\n  if (!pairCommand) await loadPairCommand();\n}\nasync function loadPairCommand() {\n  const summary = await request('/gui/summary?conversationId=' + encodeURIComponent(activeConversationId));\n  if (!summary.pairingCode) return;\n  pairCommandPrimary = 'king agent computer --pair ' + summary.pairingCode + ' --server ' + base + (summary.pairCommandTenantArg || '');\n  pairCommandStart = 'king agent computer --server ' + base + (summary.pairCommandTenantArg || '');\n  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;\n  lastConnection = summary.connection || lastConnection;\n  if (document.getElementById('computerDialog').open && computerStep === 'connect') renderComputerFlow();\n}\nfunction dismissComputerIntro() {\n  const checkbox = document.getElementById('dontRemindComputer');\n  if (checkbox && checkbox.checked) localStorage.setItem('king:addComputerDismissed', '1');\n  closeComputerDialog();\n}\nfunction renderComputerFlow() {\n  const connected = Boolean(lastConnection.online);\n  const paired = Boolean(lastConnection.paired);\n  const connectionText = connected ? 'Computer connected.' : paired ? 'Computer paired. Waiting for it to come online...' : 'Waiting for computer to connect...';\n  const flow = document.getElementById('computerFlow');\n  if (computerStep === 'select') {\n    flow.innerHTML =\n      '<div class=\"computer-actions\"><button class=\"icon button-shadow\" onclick=\"closeComputerDialog()\" aria-label=\"Close\">×</button></div>' +\n      '<h2 class=\"computer-title\">Add Computer</h2>' +\n      '<div class=\"choice-grid\">' +\n      '<button class=\"computer-choice active\" onclick=\"openComputerFlow(&quot;connect&quot;)\"><span class=\"computer-icon\">▭</span><span><strong class=\"computer-choice-title\">Your Computer</strong><span class=\"computer-muted\">Run agents on your own computer</span></span></button>' +\n      '<button class=\"computer-choice disabled\" type=\"button\"><span class=\"computer-icon\">☁</span><span><strong class=\"computer-choice-title\">Cloud Computer</strong><span class=\"computer-muted\">Coming soon</span></span></button>' +\n      '</div>' +\n      '<div class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"closeComputerDialog()\">Cancel</button><button class=\"primary-pink button-shadow\" onclick=\"openComputerFlow(&quot;connect&quot;)\">Next</button></div>';\n    return;\n  }\n  if (computerStep === 'connect') {\n    flow.innerHTML =\n      '<div class=\"computer-actions\"><button class=\"icon button-shadow\" onclick=\"closeComputerDialog()\" aria-label=\"Close\">×</button></div>' +\n      '<h2 class=\"computer-title\">Connect Computer</h2>' +\n      '<p><strong>&gt;_ Run this command on your computer to connect:</strong></p>' +\n      '<div class=\"connect-row\"><div class=\"connect-stack\">' +\n      '<div class=\"connect-help\">First-time pairing: run this once to attach this browser session.</div>' +\n      '<pre class=\"connect-command\">' + escapeHtml(pairCommandPrimary || 'Loading pairing code...') + '</pre>' +\n      '<div class=\"connect-help\">Already paired: use this later to start the local computer runtime.</div>' +\n      '<pre class=\"connect-command\">' + escapeHtml(pairCommandStart || 'Loading start command...') + '</pre></div><button class=\"icon button-shadow\" onclick=\"copyPairCommand()\" aria-label=\"Copy commands\">□</button></div>' +\n      '<div class=\"connect-status\"><span class=\"status-dot' + (connected ? ' online' : '') + '\"></span><span>' + connectionText + '</span></div>' +\n      '<div class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"closeComputerDialog()\">Cancel</button><button class=\"' + (connected ? 'primary-pink' : 'disabled-action') + ' button-shadow\" onclick=\"' + (connected ? 'closeComputerDialog()' : 'refresh()') + '\">' + (connected ? 'Done' : 'Done') + '</button></div>';\n    return;\n  }\n  flow.innerHTML =\n    '<div><div class=\"computer-kicker\">Meet King</div><h2 class=\"computer-title\">Add a Computer</h2></div>' +\n    '<div class=\"computer-lead\"><span class=\"computer-icon\">▭</span><div><p>Your agents need somewhere to run. Connect a computer and they will come online there.</p><p class=\"computer-muted\">Need an agent runtime installed: Claude Code or Codex CLI.</p></div></div>' +\n    '<div class=\"computer-rule\"></div>' +\n    '<div class=\"computer-actions between\"><label class=\"check-row\"><input id=\"dontRemindComputer\" type=\"checkbox\" />Do not remind me again</label><span class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"dismissComputerIntro()\">Skip</button><button class=\"primary-pink button-shadow\" onclick=\"openComputerFlow(&quot;select&quot;)\">▭ Add Computer</button></span></div>';\n}\nfunction showPanel(name) {\n  ['chat', 'tasks', 'files'].forEach(function(panel) {\n    document.getElementById('panel-' + panel).classList.toggle('active', panel === name);\n    document.querySelector('[data-panel=\"' + panel + '\"]').classList.toggle('active', panel === name);\n  });\n}\nfunction scrollToBottom() {\n  const workspace = document.querySelector('.workspace');\n  workspace.scrollTop = workspace.scrollHeight;\n  shouldStickToBottom = true;\n  updateBackToBottom();\n}\nfunction updateBackToBottom() {\n  const workspace = document.querySelector('.workspace');\n  const jump = document.querySelector('.jump');\n  const distance = workspace.scrollHeight - workspace.clientHeight - workspace.scrollTop;\n  const away = distance > 180;\n  shouldStickToBottom = !away;\n  jump.classList.toggle('visible', away);\n}\nasync function handleWorkspaceScroll() {\n  updateBackToBottom();\n  const workspace = document.querySelector('.workspace');\n  if (loadingOlderMessages || workspace.scrollTop > 24 || visibleMessageCount >= lastMessageTotal) return;\n  loadingOlderMessages = true;\n  const beforeHeight = workspace.scrollHeight;\n  const beforeTop = workspace.scrollTop;\n  visibleMessageCount = Math.min(visibleMessageCount + 20, lastMessageTotal);\n  await refresh({ preserveScroll: true });\n  workspace.scrollTop = workspace.scrollHeight - beforeHeight + beforeTop;\n  loadingOlderMessages = false;\n}\nasync function copyPairCommand() {\n  if (!pairCommand) return;\n  await navigator.clipboard.writeText(pairCommand).catch(function() {});\n}\nasync function sendMessage() {\n  if (sendingMessage) return;\n  const input = document.getElementById('body');\n  const button = document.getElementById('sendButton');\n  const body = input.value.trim();\n  if (!body) return;\n  sendingMessage = true;\n  input.value = '';\n  input.blur();\n  button.disabled = true;\n  button.textContent = 'Sending';\n  try {\n    await request('/gui/message', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ body, conversationId: activeConversationId })\n    });\n    visibleMessageCount = 20;\n    shouldStickToBottom = true;\n    await refresh();\n  } catch (error) {\n    input.value = body;\n    throw error;\n  } finally {\n    sendingMessage = false;\n    button.disabled = false;\n    button.textContent = 'Send';\n  }\n}\nasync function clearMessages() {\n  await request('/gui/clear-messages', { method: 'POST' });\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  await refresh();\n}\nasync function saveAgentConfig() {\n  await request('/gui/agent-config', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({\n      engine: document.getElementById('engine').value,\n      lifecycle: 'on-demand',\n      model: document.getElementById('model').value,\n      fastModel: document.getElementById('fastModel').value\n    })\n  });\n  await refresh();\n}\nfunction renderMessages(state, options) {\n  const allRows = (state.messages || []).filter(function(message) { return message.conversation_id === activeConversationId; });\n  if (allRows.length > lastMessageTotal) visibleMessageCount = 20;\n  lastMessageTotal = allRows.length;\n  visibleMessageCount = Math.min(Math.max(visibleMessageCount, 20), Math.max(lastMessageTotal, 20));\n  const rows = allRows.slice(-visibleMessageCount);\n  const hasOlder = rows.length < allRows.length;\n  const unread = rows.filter(function(message) { return !(message.readBy || []).includes('king-ceo') && message.author_kind === 'human'; }).length;\n  const olderLine = hasOlder ? 'Pull down or scroll to top to load older messages...' : 'No older messages';\n  const html = rows.length ? rows.map(function(message) {\n    if (message.author_kind === 'system') {\n      return '<div class=\"system-line\">' + escapeHtml(message.body) + '</div>';\n    }\n    const initial = message.author_kind === 'agent' ? 'A' : '人';\n    const name = message.author_kind === 'agent' ? (message.author_name || 'AI') : (message.author_name || 'you');\n    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-ceo') ? ' highlight' : '';\n    return '<article class=\"post' + unreadClass + '\"><div class=\"avatar\">' + initial + '</div><div><div class=\"post-top\"><span class=\"author\">' + escapeHtml(name) + '</span><span class=\"time\">' + formatTime(message.created_at) + '</span></div><div class=\"post-body\">' + escapeHtml(message.body) + '</div></div></article>';\n  }).join('') : '';\n  document.getElementById('chatWindow').innerHTML = '<div class=\"system-line\">' + olderLine + '</div>' + html;\n  if (options && options.preserveScroll) updateBackToBottom();\n  else if (shouldStickToBottom) scrollToBottom();\n  else updateBackToBottom();\n}\nfunction selectConversation(id) {\n  activeConversationId = id || 'king-convo';\n  localStorage.setItem('king:activeConversationId', activeConversationId);\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  refresh();\n}\nfunction createConversation() {\n  const input = document.getElementById('newWindowTitle');\n  input.value = '';\n  const dialog = document.getElementById('newWindowDialog');\n  if (!dialog.open) dialog.showModal();\n  setTimeout(function() { input.focus(); }, 0);\n}\nfunction closeNewWindowDialog() {\n  document.getElementById('newWindowDialog').close();\n}\nasync function submitConversation(event) {\n  event.preventDefault();\n  const input = document.getElementById('newWindowTitle');\n  const title = input.value.trim();\n  const submit = document.getElementById('newWindowSubmit');\n  submit.disabled = true;\n  submit.textContent = 'Creating';\n  try {\n    const result = await request('/gui/conversations', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ title })\n    });\n    activeConversationId = result.conversation.id;\n    localStorage.setItem('king:activeConversationId', activeConversationId);\n    visibleMessageCount = 20;\n    shouldStickToBottom = true;\n    closeNewWindowDialog();\n    await refresh();\n  } finally {\n    submit.disabled = false;\n    submit.textContent = 'Create';\n  }\n}\nfunction activeConversationStatus(summary, active) {\n  const state = summary.state || {};\n  const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });\n  const thinking = (state.thinkingLog || []).slice().reverse().find(function(row) { return row.action === 'mark' && (row.conversationIds || []).includes(active.id); });\n  if (typing) return 'agent 正在输入...';\n  if (thinking) return 'agent 正在处理...';\n  if ((active.unread || 0) > 0) return '等待本地 agent 回复';\n  return '';\n}\nfunction renderConversations(summary) {\n  const conversations = summary.conversations || [];\n  if (conversations.length && !conversations.some(function(row) { return row.id === activeConversationId; })) activeConversationId = conversations[0].id;\n  const active = conversations.find(function(row) { return row.id === activeConversationId; }) || conversations[0] || { id: 'king-convo', title: 'all' };\n  document.querySelector('.channel-name').textContent = active.title || active.id;\n  document.querySelector('.composer textarea').placeholder = 'Message #' + (active.title || active.id);\n  document.querySelector('.hash').textContent = active.id === 'king-convo' ? '#' : '~';\n  document.getElementById('routeSummary').textContent = activeConversationStatus(summary, active);\n  document.getElementById('conversationList').innerHTML = conversations.map(function(row) {\n    const deletable = row.id !== 'king-convo';\n    return '<div class=\"window-item' + (row.id === activeConversationId ? ' active' : '') + '\"><button class=\"window-select\" onclick=\"selectConversation(&quot;' + escapeHtml(row.id) + '&quot;)\"><span class=\"window-name\">' + escapeHtml(row.title || row.id) + '</span></button><span class=\"window-meta\">' + escapeHtml(row.unread || 0) + '</span>' + (deletable ? '<button class=\"window-delete\" onclick=\"deleteConversation(event, &quot;' + escapeHtml(row.id) + '&quot;)\" aria-label=\"Delete window\">×</button>' : '') + '</div>';\n  }).join('');\n}\nasync function deleteConversation(event, id) {\n  event.stopPropagation();\n  await request('/gui/conversations/' + encodeURIComponent(id) + '/delete', { method: 'POST' });\n  if (activeConversationId === id) {\n    activeConversationId = 'king-convo';\n    localStorage.setItem('king:activeConversationId', activeConversationId);\n  }\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  await refresh();\n}\nfunction renderTasks(state) {\n  const tasks = state.tasks || [];\n  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);\n  document.getElementById('panel-tasks').innerHTML = tasks.length ? tasks.slice().reverse().map(function(task) {\n    return '<div class=\"task-row\"><div class=\"task-top\"><h3>' + escapeHtml(task.title) + '</h3><span class=\"time\">' + escapeHtml(taskStatusLabel(task.status)) + ' P' + escapeHtml(task.priority) + '</span></div><p>' + escapeHtml(task.description || ((task.scope && task.scope.paths || []).join(', ')) || 'No description') + '</p></div>';\n  }).join('') : '<p class=\"muted\">No tasks yet.</p>';\n  const artifacts = state.artifacts || [];\n  document.getElementById('panel-files').innerHTML = artifacts.length ? artifacts.slice().reverse().map(function(artifact) {\n    return '<div class=\"task-row\"><div class=\"task-top\"><h3>' + escapeHtml(artifact.path || artifact.name || 'artifact') + '</h3><span class=\"time\">' + escapeHtml(artifact.kind || 'file') + '</span></div><p>' + escapeHtml(artifact.source || artifact.confidence || '') + '</p></div>';\n  }).join('') : '<p class=\"muted\">No files yet.</p>';\n}\nfunction renderSummary(summary) {\n  const connection = summary.connection || {};\n  const observation = summary.observation || { counts: {}, reasons: [] };\n  const counts = observation.counts || {};\n  const agent = summary.agent || {};\n  lastConnection = connection;\n  const heartbeatStat = document.getElementById('heartbeatStat');\n  if (heartbeatStat) heartbeatStat.textContent = '最近心跳：' + (connection.lastHeartbeatAt ? formatTime(connection.lastHeartbeatAt) : '未收到');\n  document.getElementById('unreadStat').textContent = String(counts.unreadMessages || 0);\n  document.getElementById('failedStat').textContent = String(counts.failedRuns || 0);\n  document.getElementById('activityBadge').textContent = String((counts.unreadMessages || 0) + (counts.failedRuns || 0));\n  renderConversations({ ...summary, state: window.__lastState || {} });\n  const observationReasons = document.getElementById('observationReasons');\n  if (observationReasons) observationReasons.textContent = (observation.reasons || []).map(reasonLabel).join('；') || '等待下一条消息。';\n  if (summary.pairingCode) {\n    pairCommandPrimary = 'king agent computer --pair ' + summary.pairingCode + ' --server ' + base + (summary.pairCommandTenantArg || '');\n  pairCommandStart = 'king agent computer --server ' + base + (summary.pairCommandTenantArg || '');\n  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;\n    if (document.getElementById('computerDialog').open) renderComputerFlow();\n  }\n  if (!connection.paired && !promptedForComputer && !localStorage.getItem('king:addComputerDismissed')) {\n    promptedForComputer = true;\n    setTimeout(function() {\n      if (!document.getElementById('settingsDialog').open && !document.getElementById('computerDialog').open) openComputerFlow('intro');\n    }, 250);\n  }\n  const engines = summary.availableEngines || [];\n  document.getElementById('engine').innerHTML = engines.length ? engines.map(function(engine) {\n    return '<option value=\"' + escapeHtml(engine) + '\"' + (engine === agent.engine ? ' selected' : '') + '>' + escapeHtml(engine) + '</option>';\n  }).join('') : '<option value=\"\">请先配对</option>';\n  document.getElementById('model').value = agent.model === 'default' ? '' : (agent.model || '');\n  document.getElementById('fastModel').value = agent.fastModel === 'default' ? '' : (agent.fastModel || '');\n  const modelRows = ['claude', 'codex'].map(function(engine) {\n    const available = engines.includes(engine);\n    const active = agent.engine === engine;\n    const label = active && !available ? '当前配置，未检测到本机' : available ? '可用' : '未检测到';\n    return '<div class=\"model-row\"><span>' + engine + (active ? ' · 当前' : '') + '</span><span class=\"' + (available ? 'available' : 'unavailable') + '\">' + label + '</span></div>';\n  }).join('');\n  document.getElementById('modelStatus').innerHTML = modelRows + '<div class=\"model-row\"><span>运行模式</span><span>' + lifecycleLabel(agent.lifecycle) + '</span></div>';\n}\nasync function refresh(options) {\n  const results = await Promise.all([\n    request('/gui/summary?conversationId=' + encodeURIComponent(activeConversationId)),\n    request('/gui/state')\n  ]);\n  window.__lastState = results[1];\n  renderSummary(results[0]);\n  renderMessages(results[1], options || {});\n  renderTasks(results[1]);\n}\nrefresh();\ndocument.querySelector('.workspace').addEventListener('scroll', handleWorkspaceScroll);\nsetInterval(refresh, 3500);\n";


function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
}

function isAgentLifecycle(value: unknown): value is AgentLifecycle {
  return value === "on-demand" || value === "24/7" || value === "idle_cached" || value === "disabled";
}

function sanitizeTenantId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 96) || "global";
}

type AuthUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type RequestContext = {
  env: Bindings;
  req: {
    raw: Request;
    header(name: string): string | undefined;
    url: string;
  };
};

function authIsConfigured(env: Bindings): boolean {
  return Boolean(env.AUTH_DB && env.BETTER_AUTH_SECRET && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function publicBaseUrl(request: Request, env: Bindings): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const url = new URL(request.url);
  return url.origin;
}

function authForRequest(request: Request, env: Bindings) {
  if (!authIsConfigured(env) || !env.AUTH_DB) return null;
  return betterAuth({
    appName: "King",
    baseURL: publicBaseUrl(request, env),
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: {
      dialect: new D1Dialect({ database: env.AUTH_DB }),
      type: "sqlite",
      transaction: false
    },
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID || "",
        clientSecret: env.GITHUB_CLIENT_SECRET || ""
      }
    },
    trustedOrigins: [publicBaseUrl(request, env)]
  });
}

async function getAuthUser(c: RequestContext): Promise<AuthUser | null> {
  const testUser = c.env.KING_TEST_AUTH_USER ? c.req.header("X-King-Test-User") : undefined;
  if (testUser) {
    const parsed = JSON.parse(testUser) as AuthUser;
    return { id: parsed.id, email: parsed.email, name: parsed.name };
  }
  const auth = authForRequest(c.req.raw, c.env);
  if (!auth) {
    if (isLocalDevRequest(c.req.raw)) {
      return { id: "local-dev", email: "local-dev@king.local", name: "Local Dev" };
    }
    return null;
  }
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null;
}

function isLocalDevRequest(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function authUserFromRequest(request: Request): AuthUser | undefined {
  const raw = request.headers.get("X-King-Auth-User");
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AuthUser;
    if (!parsed.id) return undefined;
    return { id: parsed.id, email: parsed.email, name: parsed.name };
  } catch {
    return undefined;
  }
}

function displayNameForAuthUser(user: AuthUser | undefined): string {
  return user?.name?.trim() || user?.email?.trim() || user?.id?.trim() || "King Human";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function displayNameForHuman(state: State, user: AuthUser | undefined): string {
  const fromAuth = displayNameForAuthUser(user);
  if (fromAuth !== "King Human") return fromAuth;
  const fromMessages = [...state.messages].reverse().find((message) => message.author_kind === "human" && message.author_name.trim());
  return fromMessages?.author_name.trim() || fromAuth;
}

function tenantFromAuthUser(user: AuthUser): string {
  return `user-${sanitizeTenantId(user.email || user.id)}`;
}

async function remoteAssistTenantFromRequest(c: RequestContext): Promise<string | undefined> {
  const url = new URL(c.req.url);
  const tokenValue = url.searchParams.get("assist") || c.req.header("X-King-Assist-Token");
  const tenantValue = url.searchParams.get("tenant") || c.req.header("X-King-Tenant");
  if (!tokenValue || !tenantValue) return undefined;
  const tenantId = sanitizeTenantId(tenantValue);
  const stub = c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(tenantId));
  const response = await stub.fetch("https://state/remote-assist/auth", {
    method: "POST",
    body: JSON.stringify({ token: tokenValue })
  });
  return response.ok ? tenantId : undefined;
}

async function tenantFromRequest(c: RequestContext): Promise<string> {
  const url = new URL(c.req.url);
  const explicit = url.searchParams.get("tenant") || c.req.header("X-King-Tenant");
  if (explicit) return sanitizeTenantId(explicit);
  const user = await getAuthUser(c);
  if (user) return tenantFromAuthUser(user);
  const accessEmail = c.req.header("Cf-Access-Authenticated-User-Email");
  if (accessEmail) return `user-${sanitizeTenantId(accessEmail)}`;
  const accessSub = c.req.header("Cf-Access-User-Sub");
  if (accessSub) return `user-${sanitizeTenantId(accessSub)}`;
  return "global";
	}

	async function tenantForGuiRequest(c: RequestContext): Promise<string> {
	  return await remoteAssistTenantFromRequest(c) ?? await tenantFromRequest(c);
	}

	async function stateForTenant(c: RequestContext, tenantId: string): Promise<DurableObjectStub> {
	  return c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(sanitizeTenantId(tenantId)));
	}

function splitPairCode(value: unknown): { tenantId?: string; code?: string } {
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0) return { code: trimmed };
  const tenantId = sanitizeTenantId(trimmed.slice(0, separator));
  const code = trimmed.slice(separator + 1);
  return code ? { tenantId, code } : { code: trimmed };
}

function pairingLocator(args: { serverUrl: string; tenantId: string; code: string }): string {
  const params = new URLSearchParams({ server: args.serverUrl, code: args.code });
  if (args.tenantId !== "global") params.set("tenant", args.tenantId);
  return `king://pair?${params.toString()}`;
}

	async function stateForRequest(c: RequestContext): Promise<DurableObjectStub> {
	  return c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(await tenantForGuiRequest(c)));
	}

async function forwardHeaders(c: RequestContext, headers: Record<string, string> = {}): Promise<Headers> {
  const forwarded = new Headers(headers);
  const auth = c.req.header("Authorization");
  if (auth) forwarded.set("Authorization", auth);
  forwarded.set("X-King-Tenant", await tenantForGuiRequest(c));
  forwarded.set("X-King-Public-Base", publicBaseUrl(c.req.raw, c.env));
  const user = await getAuthUser(c);
  if (user) forwarded.set("X-King-Auth-User", JSON.stringify(user));
  return forwarded;
}

function bearer(c: { req: { header(name: string): string | undefined } }): string {
  const raw = c.req.header("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

function loginPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>King Sign In</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #171717;
      background: #fff;
    }
    .topbar {
      height: 60px;
      display: flex;
      align-items: center;
      border-bottom: 2px solid #111;
      background: #ffd633;
      padding: 0 16px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #111;
      font-size: 18px;
      font-weight: 950;
      font-style: italic;
      letter-spacing: -0.02em;
      text-transform: uppercase;
      text-shadow: 2px 2px 0 #fff;
      -webkit-text-stroke: 1px #111;
    }
    .brand-mark {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      border: 3px solid #111;
      border-radius: 3px;
      background: #fff;
      box-shadow: 2px 2px 0 #111;
      transform: rotate(-10deg);
      font-size: 11px;
      line-height: 1;
      text-shadow: none;
      -webkit-text-stroke: 0;
    }
    main {
      min-height: calc(100vh - 60px);
      display: grid;
      place-items: center;
      padding: 32px 16px;
    }
    .panel {
      width: min(450px, calc(100vw - 32px));
      display: grid;
      justify-items: center;
      gap: 20px;
    }
    .login-mark {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 4px solid #111;
      border-radius: 4px;
      box-shadow: 3px 3px 0 #111;
      transform: rotate(-10deg);
      font-weight: 950;
      line-height: 1;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 20px;
      line-height: 1.1;
      font-weight: 900;
      text-align: center;
    }
    button {
      width: 100%;
      min-height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border: 2px solid #111;
      background: #050505;
      color: #fff;
      box-shadow: 4px 5px 0 #222;
      font-weight: 900;
      cursor: pointer;
    }
    button:hover { background: #171717; }
    .github-icon {
      width: 18px;
      height: 18px;
      display: block;
      fill: currentColor;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">↗</span>King</div>
  </header>
  <main>
    <section class="panel" aria-label="Sign in">
      <div class="login-mark">↗</div>
      <h1>Sign In</h1>
      <button id="githubSignIn"><svg class="github-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.64 0 8.49c0 3.75 2.39 6.93 5.7 8.05.42.08.57-.19.57-.42 0-.21-.01-.91-.01-1.65-2.32.55-2.81-1.04-2.81-1.04-.38-1-.93-1.27-.93-1.27-.76-.53.06-.52.06-.52.84.06 1.28.9 1.28.9.75 1.33 1.96.95 2.44.73.08-.56.29-.95.53-1.17-1.85-.22-3.79-.96-3.79-4.27 0-.94.32-1.71.86-2.31-.09-.22-.37-1.1.08-2.28 0 0 .7-.23 2.3.88A7.65 7.65 0 0 1 8 3.51c.71 0 1.43.1 2.1.29 1.59-1.11 2.29-.88 2.29-.88.45 1.18.17 2.06.08 2.28.54.6.86 1.37.86 2.31 0 3.32-1.95 4.05-3.8 4.27.3.27.56.79.56 1.6 0 1.16-.01 2.09-.01 2.37 0 .23.15.5.57.42A8.33 8.33 0 0 0 16 8.49C16 3.64 12.42 0 8 0Z"/></svg>Continue with GitHub</button>
    </section>
  </main>
  <script>
    document.getElementById('githubSignIn').addEventListener('click', async function() {
      const response = await fetch(location.origin + '/api/auth/sign-in/social', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'github', callbackURL: location.origin + '/' })
      });
      if (!response.ok) throw new Error(await response.text());
      const payload = await response.json();
      location.href = payload.url || '/';
    });
  </script>
</body>
</html>`;
}

async function requireGuiAuth(c: RequestContext): Promise<Response | null> {
  if (await remoteAssistTenantFromRequest(c)) return null;
  if (!authIsConfigured(c.env)) return null;
  const user = await getAuthUser(c);
  if (user) return null;
  if (new URL(c.req.url).pathname.startsWith("/gui/")) {
    return json({ error: "login_required" }, { status: 401 });
  }
  return new Response(loginPage(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 401
  });
}

async function requireOwnerGuiAuth(c: RequestContext): Promise<Response | null> {
  if (await remoteAssistTenantFromRequest(c)) return json({ error: "owner_login_required" }, { status: 403 });
  return requireGuiAuth(c);
}

type HostBridgeCard = {
  id: string;
  title?: string;
  status?: string;
  ownerRole?: string;
  reviewerRole?: string;
  decisionBy?: string;
  detail?: string;
  createdAt?: string;
};

type HostDecisionsResult = {
  configured: boolean;
  cards: HostBridgeCard[];
  error?: string;
};

type HostCommandResult<T = unknown> = {
  ok?: boolean;
  text?: string;
  json?: T;
  error?: string;
};

function hostBridgeOutputDir(env: Bindings): Record<string, string> {
  const dir = typeof env.KING_HOST_OUTPUT_DIR === "string" ? env.KING_HOST_OUTPUT_DIR.trim() : "";
  return dir ? { outputDir: dir } : {};
}

function localHostBridgeUrl(request: Request): string {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1"
    ? "http://127.0.0.1:8799"
    : "";
}

function hostBridgeSdk(env: Bindings, request: Request) {
  const configuredUrl = typeof env.KING_HOST_URL === "string" ? env.KING_HOST_URL.trim() : "";
  const baseUrl = configuredUrl || localHostBridgeUrl(request);
  if (!baseUrl) return null;
  return createHostSdk({ baseUrl, fetch: (input, init) => fetch(input as RequestInfo, init) });
}

async function fetchHostDecisions(env: Bindings, request: Request): Promise<HostDecisionsResult> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { configured: false, cards: [] };
  try {
    const result = await sdk.runCommand<{ cards?: HostBridgeCard[] }>({
      command: "workflow-list",
      actorRole: "reviewer",
      input: { kind: "decision", status: "waiting_human", limit: 50, ...hostBridgeOutputDir(env) }
    });
    const cards = result.json && Array.isArray(result.json.cards) ? result.json.cards : [];
    return { configured: true, cards, error: result.ok ? undefined : result.error || "host command failed" };
  } catch (err) {
    return { configured: true, cards: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveHostDecision(env: Bindings, request: Request, id: string, decision: "approve" | "deny"): Promise<{ ok: boolean; card?: unknown; error?: string }> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { ok: false, error: "host bridge not configured" };
  try {
    const result = await sdk.runCommand<{ card?: unknown }>({
      command: "workflow-update",
      actorRole: "reviewer",
      input: {
        id,
        status: decision === "approve" ? "done" : "cancelled",
        result: decision === "approve" ? "approved from gui" : "denied from gui",
        humanApproved: decision === "approve" ? true : undefined,
        approvedBy: decision === "approve" ? "gui-human" : undefined,
        ...hostBridgeOutputDir(env)
      }
    });
    return { ok: result.ok, card: result.json?.card, error: result.ok ? undefined : result.error || result.text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function runHostRemoteCommand<T = unknown>(env: Bindings, request: Request, command: string, input?: unknown): Promise<{ configured: boolean; result?: HostCommandResult<T>; error?: string }> {
  const sdk = hostBridgeSdk(env, request);
  if (!sdk) return { configured: false, error: "host bridge not configured" };
  try {
    const result = await sdk.runCommand<T>({ command, input });
    return { configured: true, result };
  } catch (err) {
    return { configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

const app = new Hono<Env>();
app.use("*", cors());

app.on(["GET", "POST"], "/api/auth/*", (c) => {
  const auth = authForRequest(c.req.raw, c.env);
  if (!auth) return json({ error: "auth_not_configured" }, { status: 404 });
  return auth.handler(c.req.raw);
});

app.get("/", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return c.html(renderPage(styles, clientScript));
});
app.get("/favicon.ico", () => new Response(null, { status: 204 }));

app.post("/api/computers/pair", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pairCode = splitPairCode((body as { code?: unknown }).code);
  const tenantId = c.req.header("X-King-Tenant") || pairCode.tenantId || await tenantFromRequest(c);
  const stub = c.env.GUI_STATE.get(c.env.GUI_STATE.idFromName(sanitizeTenantId(tenantId)));
  const headers = await forwardHeaders(c);
  headers.set("X-King-Tenant", sanitizeTenantId(tenantId));
  return stub.fetch("https://state/pair", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, code: pairCode.code ?? (body as { code?: unknown }).code })
  });
});

app.get("/api/computers/me/agents", async (c) => {
  const stub = await stateForRequest(c);
  return stub.fetch("https://state/agents", { headers: await forwardHeaders(c) });
});

app.post("/api/computers/heartbeat", async (c) => await (await stateForRequest(c)).fetch("https://state/heartbeat", {
  method: "POST",
  headers: await forwardHeaders(c),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));

app.post("/api/agents/:agentId/runtime-token", async (c) => {
  const stub = await stateForRequest(c);
  return stub.fetch(`https://state/runtime-token/${c.req.param("agentId")}`, {
    method: "POST",
    headers: await forwardHeaders(c)
  });
});

app.get("/runtime/wake-stream", async (c) => await (await stateForRequest(c)).fetch("https://state/wake-stream", {
  headers: await forwardHeaders(c)
}));

app.get("/runtime/inbox", async (c) => await (await stateForRequest(c)).fetch("https://state/inbox", {
  headers: await forwardHeaders(c)
}));

app.get("/runtime/inbox-triage/payload", async (c) => await (await stateForRequest(c)).fetch("https://state/triage", {
  headers: await forwardHeaders(c)
}));

app.get("/runtime/agenda", async (c) => await (await stateForRequest(c)).fetch("https://state/agenda", {
  headers: await forwardHeaders(c)
}));

app.get("/runtime/roster", async (c) => await (await stateForRequest(c)).fetch("https://state/roster", {
  headers: await forwardHeaders(c)
}));

app.get("/runtime/preamble", async (c) => await (await stateForRequest(c)).fetch(`https://state/preamble?${new URL(c.req.url).searchParams.toString()}`, {
  headers: await forwardHeaders(c)
}));

app.post("/runtime/cli", async (c) => await (await stateForRequest(c)).fetch("https://state/cli", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json())
}));

app.post("/runtime/status", async (c) => await (await stateForRequest(c)).fetch("https://state/status", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/typing", async (c) => await (await stateForRequest(c)).fetch("https://state/typing", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/thinking/mark", async (c) => await (await stateForRequest(c)).fetch("https://state/thinking/mark", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/thinking/unmark", async (c) => await (await stateForRequest(c)).fetch("https://state/thinking/unmark", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/events", async (c) => await (await stateForRequest(c)).fetch("https://state/events", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/notices", async (c) => await (await stateForRequest(c)).fetch("https://state/notices", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/triage", async (c) => await (await stateForRequest(c)).fetch("https://state/triage-log", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/runs", async (c) => await (await stateForRequest(c)).fetch("https://state/runs", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/runs/:runId/heartbeat", async (c) => await (await stateForRequest(c)).fetch(`https://state/runs/${c.req.param("runId")}/heartbeat`, {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/runs/:runId/finish", async (c) => await (await stateForRequest(c)).fetch(`https://state/runs/${c.req.param("runId")}/finish`, {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/conversation/mark-read", async (c) => await (await stateForRequest(c)).fetch("https://state/mark-read", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json())
}));

app.get("/gui/state", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const isRemoteAssist = Boolean(new URL(c.req.url).searchParams.get("assist") || c.req.header("X-King-Assist-Token"));
  return (await stateForRequest(c)).fetch(`https://state/gui-state${isRemoteAssist ? "?redact=1" : ""}`);
});
app.get("/gui/summary", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const search = new URL(c.req.url).search;
  return (await stateForRequest(c)).fetch(`https://state/gui-summary${search}`, { headers: await forwardHeaders(c) });
});
app.get("/gui/activity", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-activity?${new URL(c.req.url).searchParams.toString()}`);
});
app.get("/gui/export-state", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-export-state");
});
app.post("/gui/import-state", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-import-state", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => null))
  });
});
app.post("/gui/reset-state", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-reset-state", { method: "POST" });
});
app.post("/gui/message", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-message", {
  method: "POST",
  headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/attachments", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-attachments", {
    method: "POST",
    headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.get("/gui/attachments/:attachmentId", async (c) => {
  const url = new URL(c.req.url);
  const tenantId = url.searchParams.get("tenant") || c.req.header("X-King-Tenant") || "global";
  return (await stateForTenant(c, tenantId)).fetch(`https://state/gui-attachments/${encodeURIComponent(c.req.param("attachmentId"))}?${url.searchParams.toString()}`);
});
app.post("/gui/conversations", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-conversations", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/conversations/:conversationId/team", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-conversations/${c.req.param("conversationId")}/team`, {
    method: "POST",
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/conversations/:conversationId/delete", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-conversations/${c.req.param("conversationId")}/delete`, { method: "POST" });
});
app.post("/gui/clear-messages", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-clear-messages", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/agent-config", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-agent-config", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/card", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-card", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/task", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-task", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/task/:taskId/update", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-task/${c.req.param("taskId")}/update`, {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/card/:cardId/move", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-card/${c.req.param("cardId")}/move`, {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/conversation/mark-read", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-conversation/mark-read", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/wake", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-wake", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/remote-assist/share", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-remote-assist/share", {
    method: "POST",
    headers: await forwardHeaders(c, { "Content-Type": "application/json" }),
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/remote-assist/revoke", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch("https://state/gui-remote-assist/revoke", {
    method: "POST",
    body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.post("/gui/approvals/:id/resolve", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return (await stateForRequest(c)).fetch(`https://state/gui-approval/${encodeURIComponent(c.req.param("id"))}/resolve`, {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
  });
});
app.get("/gui/host-decisions", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  return json(await fetchHostDecisions(c.env, c.req.raw));
});
app.post("/gui/host-decisions/:id/resolve", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const body = await c.req.json().catch(() => ({})) as { decision?: string };
  const decision = body.decision === "approve" || body.decision === "approved"
    ? "approve"
    : body.decision === "deny" || body.decision === "denied"
      ? "deny"
      : undefined;
  if (!decision) return json({ ok: false, error: "decision must be approve or deny" }, { status: 400 });
  const result = await resolveHostDecision(c.env, c.req.raw, c.req.param("id"), decision);
  return json(result, { status: result.ok ? 200 : result.error === "host bridge not configured" ? 404 : 400 });
});
app.get("/gui/remote-config", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-config-get", { revealSecrets: true });
  return json(result, { status: result.configured ? 200 : 404 });
});
app.put("/gui/remote-config", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  const payload = await c.req.json().catch(() => ({}));
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-config-save", payload);
  return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
});
app.get("/gui/remote-devices", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-list");
  return json(result, { status: result.configured ? 200 : 404 });
});
app.post("/gui/remote-devices", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  const payload = await c.req.json().catch(() => ({}));
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-save-device", payload);
  return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
});
app.delete("/gui/remote-devices/:id", async (c) => {
  const blocked = await requireOwnerGuiAuth(c);
  if (blocked) return blocked;
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-delete-device", { id: c.req.param("id") });
  return json(result, { status: result.configured && result.result?.ok !== false ? 200 : result.configured ? 400 : 404 });
});
app.post("/gui/remote-devices/:id/probe", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-probe", { device: c.req.param("id") });
  return json(result, { status: result.configured ? 200 : 404 });
});
app.post("/gui/remote-devices/:id/profile", async (c) => {
  const blocked = await requireGuiAuth(c);
  if (blocked) return blocked;
  const result = await runHostRemoteCommand(c.env, c.req.raw, "remote-profile", { device: c.req.param("id") });
  return json(result, { status: result.configured ? 200 : 404 });
});

export class GuiState implements DurableObject {
  private waiters = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(private state: DurableObjectState) {}

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
    if (path === "/gui-state") return json(await stateForGui(await this.get(), url.searchParams.get("redact") === "1"));
    if (path === "/gui-summary") return this.guiSummary(request);
    if (path === "/gui-activity") return this.guiActivity(url.searchParams);
    if (path === "/gui-export-state") return json(this.snapshot(await this.get()));
    if (path === "/gui-import-state") return this.importSnapshot(await request.json().catch(() => null));
    if (path === "/gui-reset-state") return this.resetState();
    if (path === "/gui-message") return this.guiMessage(request, await request.json() as { body?: string; conversationId?: string; attachments?: unknown });
    if (path === "/gui-attachments" && request.method === "POST") return this.guiAttachment(request, await request.json().catch(() => ({})));
    if (path.startsWith("/gui-attachments/") && request.method === "GET") return this.guiAttachmentFile(new URL(request.url), decodeURIComponent(path.slice("/gui-attachments/".length)));
    if (path === "/gui-conversations") return this.guiConversation(await request.json().catch(() => ({})) as GuiConversationPayload);
    if (path.startsWith("/gui-conversations/") && path.endsWith("/team")) return this.guiUpdateConversationTeam(path.split("/")[2], await request.json().catch(() => ({})) as GuiConversationPayload);
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
    const saved = await this.state.storage.get<State>("state");
    if (saved) {
      const shouldPersist = !saved.pairingCode;
      const normalized = this.normalizeState(saved);
      if (shouldPersist) await this.put(normalized);
      return normalized;
    }
    const initial = this.freshState();
    await this.put(initial);
    return initial;
  }

  private freshState(): State {
    const initial: State = {
      computerId: "king-computer",
      deviceToken: crypto.randomUUID(),
      runtimeToken: crypto.randomUUID(),
      runtimeTokens: {},
      pairingCode: crypto.randomUUID(),
      availableEngines: [],
      capabilities: { workspaces: [] },
      agents: defaultTeamAgents(),
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

  private async put(state: State): Promise<void> {
    await this.state.storage.put("state", state);
  }

  private normalizeState(saved: State): State {
    saved.initiatives ??= [];
    saved.pairingCode ??= crypto.randomUUID();
    saved.runtimeToken ??= crypto.randomUUID();
    saved.runtimeTokens ??= {};
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
    saved.remoteAssist = normalizeRemoteAssistGrant(saved.remoteAssist, (saved as State & { remoteAssistGrants?: unknown }).remoteAssistGrants);
    saved.agents = normalizeAgents(saved.agents);
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
    saved.runStreams = saved.runStreams ?? {};
    saved.capabilities ??= { workspaces: [] };
    saved.availableEngines ??= [];
    return saved;
  }

  private snapshot(state: State): StateSnapshot {
    return {
      schema: "king.gui-state.v1",
      exportedAt: Date.now(),
      state
    };
  }

  private async importSnapshot(payload: unknown): Promise<Response> {
    if (!payload || typeof payload !== "object") return json({ error: "expected state snapshot JSON" }, { status: 400 });
    const record = payload as Partial<StateSnapshot> & { state?: unknown };
    if (record.schema !== "king.gui-state.v1" || !record.state || typeof record.state !== "object") {
      return json({ error: "unsupported or malformed state snapshot" }, { status: 400 });
    }
    const incoming = this.normalizeState(record.state as State);
    if (!incoming.computerId || !incoming.deviceToken || !incoming.runtimeToken || !incoming.pairingCode) {
      return json({ error: "snapshot is missing pairing tokens" }, { status: 400 });
    }
    await this.put(incoming);
    await this.broadcast({ event: "wake", data: { importedState: true, at: Date.now() } });
    return json({ ok: true, messages: incoming.messages.length, agents: incoming.agents.length });
  }

  private async resetState(): Promise<Response> {
    const fresh = this.freshState();
    await this.put(fresh);
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
    await this.put(state);
    return json({ computerId: state.computerId, deviceToken: state.deviceToken, tenantId: tenantHeader(request) });
  }

  private async runtimeToken(agentIdRaw?: string): Promise<Response> {
    const state = await this.get();
    const agentId = normalizeAgentId(decodeURIComponent(agentIdRaw || "")) ?? "";
    const agent = findAgent(state, agentId) ?? defaultAgentFor(state);
    state.runtimeTokens ??= {};
    const runtimeToken = crypto.randomUUID();
    state.runtimeTokens[agent.id] = runtimeToken;
    if (agent.id === DEFAULT_AGENT.id) state.runtimeToken = runtimeToken;
    await this.put(state);
    return json({ token: runtimeToken, expiresInSeconds: 3600 });
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
    const publicBase = request.headers.get("X-King-Public-Base") || new URL(request.url).origin;
    const remoteAssist = activeRemoteAssistGrant(state);
    const isRemoteAssist = Boolean(new URL(request.url).searchParams.get("assist") || request.headers.get("X-King-Assist-Token"));
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
        summary: summarizeUnknown(row.body),
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

  private async wakeStream(_agentId: string): Promise<Response> {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    this.waiters.add(writer);
    await writer.write(encode(": connected\n\n"));
    requestKeepAlive(writer, () => this.waiters.delete(writer));
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
    return json({
      instructions: "Return strict JSON: {\"actionable\": boolean, \"reason\": string, \"promptNote\": string, \"routeHint\": \"ignore|monitor|respond|steer\", \"priority\": \"normal|steer|urgent\"}. Mark human messages actionable and prioritize blocker, approval, decision, direct, and @mention messages.",
      input: routed.map((item) => `${messageRouteTag(item)} score=${item.score} ${item.row.author_name}: ${item.row.body}`).join("\n"),
      routeSummary: formatMessageRouteSummary(unread, agentId),
      verdict: unread.length ? {
        actionable: top ? top.route !== "ignore" : true,
        reason: top ? `gui unread message routed ${messageRouteTag(top)}` : "gui unread message",
        promptNote: "Handle the highest-priority routed message first. Reply through king reply king-convo --file notes/reply.md or a short inline reply.",
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

  private async cli(payload: { argv?: string[]; agentId?: string; tokenAgentId?: string; engine?: string; authUser?: AuthUser }): Promise<Response> {
    const argv = payload.argv ?? [];
    const state = await this.get();
    const actor = findAgent(state, payload.agentId) ?? findAgent(state, payload.tokenAgentId) ?? defaultAgentFor(state);
    const authorEngine = activeRunEngine(state) ?? normalizeEngineId(payload.engine) ?? actor.engine;
    let result = "";
    if (argv[0] === "reply") {
      const conversationId = argv[1] || "king-convo";
      const quoteIdx = argv.indexOf("--quote");
      const quoted = quoteIdx >= 0 ? argv[quoteIdx + 1] : undefined;
      const bodyArgs = argv.slice(2).filter((_, idx) => {
        const absoluteIdx = idx + 2;
        return absoluteIdx !== quoteIdx && absoluteIdx !== quoteIdx + 1;
      });
      const body = bodyArgs.join(" ").trim() || "(empty reply)";
      const conversation = ensureConversation(state, conversationId);
      const now = Date.now();
      const pending = [...state.messages].reverse().find((message) =>
        message.conversation_id === conversation.id &&
        message.author_kind === "agent" &&
        message.status === "pending" &&
        pendingBelongsToAgent(message, actor)
      );
      const reply: Message = {
        id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
        conversation_id: conversation.id,
        conversation_title: conversation.title,
        conversation_kind: conversation.kind,
        author_name: actor.name,
        author_kind: "agent",
        author_engine: authorEngine,
        status: "done",
        kind: "message",
        body,
        quoted_message_id: quoted,
        created_at: now,
        readBy: [actor.id]
      };
      if (pending) {
        Object.assign(pending, {
          author_name: reply.author_name,
          author_engine: reply.author_engine,
          status: reply.status,
          body: reply.body,
          quoted_message_id: reply.quoted_message_id,
          created_at: reply.created_at,
          to_agent_id: undefined,
          readBy: reply.readBy
        });
      } else {
        state.messages.push(reply);
      }
      conversation.updated_at = now;
      result = "reply posted";
    } else if (argv[0] === "state") {
      result = await this.stateCommand(state, argv.slice(1));
    } else if (argv[0] === "inbox") {
      result = JSON.stringify(unreadMessagesFor(state, actor.id), null, 2);
    } else if (argv[0] === "messages") {
      const conversationId = argv[1] || "king-convo";
      const tailIdx = argv.indexOf("--tail");
      const tail = tailIdx >= 0 ? Number(argv[tailIdx + 1]) : 0;
      const rows = state.messages.filter((m) => m.conversation_id === conversationId && isRuntimeVisibleMessage(m));
      result = JSON.stringify(tail > 0 ? rows.slice(-tail) : rows, null, 2);
    } else if (argv[0] === "glance") {
      const conversationId = argv[1] || "king-convo";
      const rows = state.messages.filter((m) => m.conversation_id === conversationId && isRuntimeVisibleMessage(m)).slice(-10);
      const now = Date.now();
      state.composing = state.composing.filter((claim) => claim.expires_at > now);
      const composing = state.composing
        .filter((claim) => claim.conversationId === conversationId)
        .sort((a, b) => a.claimed_at - b.claimed_at)
        .map((claim) => `Composing: ${claim.agentName} (claimed ${Math.max(0, ((now - claim.claimed_at) / 1000)).toFixed(1)}s ago)`)
        .join("\n");
      const claims = state.claims.filter((claim) => claim.conversationId === conversationId).map((claim) => `Claim: ${claim.name} by ${claim.owner}`).join("\n");
      result = rows.map((m) => `[${m.id}] ${m.author_name}${m.author_kind === "agent" ? " ▸ME" : ""}: ${m.body}`).join("\n") +
        (claims ? `\n${claims}` : "") +
        (composing ? `\n${composing}` : "");
    } else if (argv[0] === "roster" || argv[0] === "participants") {
      result = state.agents.map((agent) => formatRosterAgent(agentStateSummary(state, agent))).join("\n");
    } else if (argv[0] === "preamble") {
      result = buildRuntimePreamble(state, {
        agentId: readOption(argv.slice(1), "--agent") || argv[1] || DEFAULT_AGENT.id,
        reason: readOption(argv.slice(1), "--reason") || "cli",
        runId: readOption(argv.slice(1), "--run"),
        steerReason: readOption(argv.slice(1), "--steer-reason")
      });
    } else if (argv[0] === "agents") {
      result = this.agentsCommand(state, argv.slice(1));
    } else if (argv[0] === "contacts") {
      const query = argv.slice(1).join(" ").trim().toLowerCase();
      const humanName = displayNameForHuman(state, payload.authUser);
      const rows = [
        ...state.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: "agent",
          role: agent.role,
          engine: agent.engine ?? "auto"
        })),
        { id: "gui-human", name: humanName, kind: "human", role: "Runtime operator", engine: undefined }
      ];
      const filtered = query
        ? rows.filter((row) => [row.id, row.name, row.kind, row.role, row.engine].filter(Boolean).join(" ").toLowerCase().includes(query))
        : rows;
      result = filtered.map((row) => `${row.id}\t${row.name}\t${row.kind}\t${row.role}${row.engine ? `\t${row.engine}` : ""}`).join("\n");
    } else if (argv[0] === "whoami") {
      result = JSON.stringify(agentStateSummary(state, actor), null, 2);
    } else if (argv[0] === "status") {
      result = JSON.stringify({
        agent: actor,
        agentState: agentStateSummary(state, actor),
        status: state.statusLog.at(-1)?.status ?? "unknown",
        availableEngines: state.availableEngines
      }, null, 2);
    } else if (argv[0] === "observe" || argv[0] === "watch") {
      result = this.observeCommand(state, argv.slice(1));
    } else if (argv[0] === "loop") {
      result = this.loopCommand(state, argv.slice(1));
    } else if (argv[0] === "card") {
      result = this.cardCommand(state, argv.slice(1));
    } else if (argv[0] === "task") {
      result = this.taskCommand(state, argv.slice(1), actor);
    } else if (argv[0] === "initiative") {
      result = this.initiativeCommand(state, argv.slice(1));
    } else if (argv[0] === "capsule") {
      result = this.capsuleCommand(state, argv.slice(1));
    } else if (argv[0] === "merge") {
      result = this.mergeCommand(state, argv.slice(1));
    } else if (argv[0] === "eval" || argv[0] === "evaluate") {
      result = this.evalCommand(state, argv.slice(1));
    } else if (argv[0] === "feedback") {
      result = this.feedbackCommand(state, argv.slice(1));
    } else if (argv[0] === "review") {
      result = this.reviewCommand(state, argv.slice(1));
    } else if (argv[0] === "route") {
      result = this.routeCommand(state, argv.slice(1));
    } else if (argv[0] === "calendar") {
      result = this.calendarCommand(state, argv.slice(1));
    } else if (argv[0] === "claim") {
      result = this.claimCommand(state, argv.slice(1));
    } else if (argv[0] === "unclaim") {
      result = this.unclaimCommand(state, argv.slice(1));
    } else if (argv[0] === "dm") {
      result = this.dmCommand(state, argv.slice(1));
    } else if (argv[0] === "react" || argv[0] === "reaction") {
      result = this.reactCommand(state, argv.slice(1));
    } else if (argv[0] === "doc") {
      result = this.docCommand(state, argv.slice(1));
    } else if (argv[0] === "artifact") {
      result = this.artifactCommand(state, argv.slice(1));
    } else if (argv[0] === "context") {
      result = this.contextCommand(state, argv.slice(1));
    } else if (argv[0] === "hypothesis") {
      result = this.hypothesisCommand(state, argv.slice(1));
    } else if (argv[0] === "plan") {
      result = this.planCommand(state, argv.slice(1));
    } else if (argv[0] === "safety" || argv[0] === "approval") {
      result = this.safetyCommand(state, argv.slice(1));
    } else if (argv[0] === "send") {
      result = this.sendCommand(state, argv.slice(1));
    } else if (argv[0] === "recv") {
      result = this.recvCommand(state, argv.slice(1));
    } else if (argv[0] === "escalate") {
      result = this.escalateCommand(state, argv.slice(1));
    } else if (argv[0] === "agenda") {
      result = JSON.stringify((await this.agenda(actor.id).then((res) => res.json())) as AgendaPayload, null, 2);
    } else if (argv[0] === "help" || argv[0] === "--help") {
      result = [
        "king gui commands:",
        "  king inbox",
        "  king messages <conversationId> [--tail n]",
        "  king glance <conversationId>",
        "  king agents [spawn|destroy]",
        "  king roster",
        "  king participants",
        "  king preamble [--agent agent-id] [--reason wake|agenda] [--run run-id]",
        "  king contacts [query]",
        "  king whoami",
        "  king reply <conversationId> <text>",
        "  king send <agentId> <message> [--steer] [--type message|decision|blocker]",
        "  king recv [--agent agent-id]",
        "  king escalate <message>",
        "  king status",
        "  king state export|import|reset",
        "  king observe [--json] [--classification productive|idle|blocked|backlog_stuck|error]",
        "  king loop tick|emit|classify|recent|snapshot [--json] [--type eventType] [--agent agent-id]",
        "  king task create|list|get|update|done [--after a,b] [--path a,b] [--assign agent-id]",
        "  king initiative create|list|get|update [--goal text] [--status active|paused|completed|abandoned]",
        "  king capsule create|list|mine|get|update [--paths a,b] [--owner agent-id] [--reviewer agent-id]",
        "  king merge enqueue|list|get|mark [--capsule id] [--task id] [--branch name]",
        "  king eval parse|record|list|get '<json evaluation>' [--artifact id] [--initiative id]",
        "  king feedback record|list|summary|get [--agent agent-id] [--completed true|false]",
        "  king review record|list|get [--capsule id] [--coverage pct] [--checks true|false]",
        "  king route set|list|delete|emit <eventType> [--agent agent-id] [--source source] '<payload json>'",
        "  king card list|create|claim|move|done|release [--paths a,b] [--owner agent-id]",
        "  king calendar list|create",
        "  king claim <name> [--in <conversationId>] [--paths a,b] [--owner agent-id]",
        "  king unclaim <claimId>",
        "  king dm <agentId> <text>",
        "  king react <messageId> <emoji>",
        "  king doc list|create|show|append|update",
        "  king artifact put|list|get|check --kind <kind> --path <path> --source <source> --confidence <0-1>",
        "  king context get|set|list|delete <key> [value]",
        "  king hypothesis create|list|update [--status <status>] [--evidence artifact-ids]",
        "  king plan parse|apply '<json plan>' [--assign agent-id] [--initiative id]",
        "  king safety check|request|list|get|approve|deny <action|approvalId>"
      ].join("\n");
    } else {
      result = `gui runtime received: ${argv.join(" ")}`;
    }
    state.cliLog.push({ at: Date.now(), agentId: actor.id, argv, result });
    await this.put(state);
    return json({ exitCode: 0, text: result });
  }

  private cardCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") return JSON.stringify(state.cards, null, 2);
    if (cmd === "create") {
      const allowedPaths = parseAllowedPaths(args);
      const title = stripOptions(args.slice(1), ["--paths", "--path"]).join(" ").trim() || "Untitled card";
      const card = this.newCard(state, title, undefined, allowedPaths);
      return `card created ${card.id}${allowedPaths.length ? ` paths=${allowedPaths.join(",")}` : ""}`;
    }
    if (cmd === "claim") {
      const id = args[1];
      const owner = readOption(args, "--owner") || DEFAULT_AGENT.id;
      const card = state.cards.find((row) => row.id === id);
      if (!card) return `card not found: ${id}`;
      if (card.claimedBy && card.claimedBy !== owner) return `card already claimed by ${card.claimedBy}`;
      const conflict = pathConflict(state, card.allowedPaths ?? [], owner, card.id);
      if (conflict) return `path conflict: ${conflict}`;
      card.claimedBy = owner;
      card.assignee = owner;
      card.column = "doing";
      return `card claimed ${card.id}${card.allowedPaths?.length ? ` paths=${card.allowedPaths.join(",")}` : ""}`;
    }
    if (cmd === "release" || cmd === "unclaim") {
      const id = args[1];
      const card = state.cards.find((row) => row.id === id);
      if (!card) return `card not found: ${id}`;
      card.claimedBy = undefined;
      return `card released ${card.id}`;
    }
    if (cmd === "done") {
      const id = args[1];
      const card = state.cards.find((row) => row.id === id);
      if (!card) return `card not found: ${id}`;
      card.column = "done";
      card.claimedBy = undefined;
      return `card moved ${card.id} done`;
    }
    if (cmd === "move") {
      const id = args[1];
      const column = args[2] as Card["column"] | undefined;
      const card = state.cards.find((row) => row.id === id);
      if (!card) return `card not found: ${id}`;
      if (column !== "todo" && column !== "doing" && column !== "done") return "usage: king card move <id> todo|doing|done";
      card.column = column;
      if (column === "done") card.claimedBy = undefined;
      return `card moved ${card.id} ${column}`;
    }
    return "usage: king card list|create|claim|move|done|release";
  }

  private async stateCommand(state: State, args: string[]): Promise<string> {
    const cmd = args[0] || "export";
    if (cmd === "export") return JSON.stringify(this.snapshot(state), null, 2);
    if (cmd === "import") {
      const raw = args.slice(1).join(" ").trim();
      if (!raw) return "usage: king state import '<snapshot json>'";
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        return `invalid snapshot JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
      const res = await this.importSnapshot(payload);
      return await res.text();
    }
    if (cmd === "reset") {
      const res = await this.resetState();
      return await res.text();
    }
    return "usage: king state export|import|reset";
  }

  private agentsCommand(state: State, args: string[]): string {
    const cmd = args[0];
    if (cmd === "spawn") return "agent spawn is not supported by this gui runtime";
    if (cmd === "destroy") return "agent destroy is not supported by this gui runtime";
    const agents = state.agents.map((agent) => agentStateSummary(state, agent));
    if (agents.length === 0) return "No agents configured.";
    return ["Agent Matrix:", "-".repeat(56), ...agents.map(formatAgentMatrixLine)].join("\n");
  }

  private observeCommand(state: State, args: string[]): string {
    const snapshot = buildLoopSnapshot(state);
    const filter = readOption(args, "--classification");
    if (filter && snapshot.classification !== filter) return `No observe snapshot matching classification=${filter}. Current classification=${snapshot.classification}.`;
    if (args.includes("--json")) return JSON.stringify(snapshot, null, 2);
    return [
      `classification=${snapshot.classification}`,
      `reasons=${snapshot.reasons.join("; ")}`,
      `unread=${snapshot.counts.unreadMessages}`,
      `blocked=${snapshot.counts.blockedTasks}`,
      `activeTasks=${snapshot.counts.activeTasks}`,
      `openCapsules=${snapshot.counts.openCapsules}`,
      `inReviewCapsules=${snapshot.counts.inReviewCapsules}`,
      `artifacts=${snapshot.counts.artifacts}`,
      `failedRuns=${snapshot.counts.failedRuns}`
    ].join("\n");
  }

  private loopCommand(state: State, args: string[]): string {
    const cmd = args[0] || "recent";
    if (cmd === "tick") {
      const runId = readOption(args, "--run") || state.loopRunId || "run-gui";
      state.loopRunId = runId;
      state.currentLoop += 1;
      pushLoopEvent(state, { type: "loop.tick", runId, loop: state.currentLoop });
      return `loop tick ${state.currentLoop} run=${runId}`;
    }
    if (cmd === "emit") {
      const type = args[1];
      if (!isLoopEventType(type)) return "usage: king loop emit <eventType> [--agent id] [--task id] [--pending n] '<payload json>'";
      const event = pushLoopEvent(state, {
        type,
        agent: readOption(args, "--agent"),
        taskId: readOption(args, "--task"),
        from: readOption(args, "--from"),
        to: readOption(args, "--to"),
        waitingOn: parseCsvOption(args, "--waiting-on"),
        pendingMessages: readNumberOption(args, "--pending"),
        kind: readOption(args, "--kind"),
        path: readOption(args, "--path"),
        tokens: readNumberOption(args, "--tokens"),
        budget: readNumberOption(args, "--budget"),
        payload: parseEventPayload(args.slice(2))
      });
      return `loop event ${event.type} recorded loop=${event.loop}`;
    }
    if (cmd === "classify") {
      const snapshot = buildEventLoopSnapshot(state);
      pushLoopEvent(state, {
        type: "loop.classified",
        classification: snapshot.classification,
        reasons: snapshot.reasons
      });
      return `loop classified ${snapshot.classification}: ${snapshot.reasons.join("; ")}`;
    }
    if (cmd === "snapshot") {
      const snapshot = buildEventLoopSnapshot(state);
      return args.includes("--json")
        ? JSON.stringify(snapshot, null, 2)
        : [
            `run=${snapshot.runId}`,
            `loop=${snapshot.loop}`,
            `classification=${snapshot.classification}`,
            `reasons=${snapshot.reasons.join("; ")}`,
            `events=${snapshot.recentEvents?.length ?? 0}`
          ].join("\n");
    }
    if (cmd === "recent" || cmd === "list") {
      const type = readOption(args, "--type");
      const agent = readOption(args, "--agent");
      const limit = normalizePositiveInt(readOption(args, "--limit"), 20);
      const rows = state.loopEvents
        .filter((event) => (!type || event.type === type) && (!agent || event.agent === agent))
        .slice(-limit);
      if (args.includes("--json")) return JSON.stringify(rows, null, 2);
      if (rows.length === 0) return "No loop events found.";
      return rows.map(formatLoopEventLine).join("\n") + `\n\n${rows.length} loop event(s)`;
    }
    return "usage: king loop tick|emit|classify|recent|snapshot";
  }

  private taskCommand(state: State, args: string[], actor = defaultAgentFor(state)): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const status = readOption(args, "--status") as TaskStatus | undefined;
      const assignee = readOption(args, "--assignee") || readOption(args, "--assign");
      const initiative = readOption(args, "--initiative");
      const capsule = readOption(args, "--capsule");
      const tasks = state.tasks.filter((task) =>
        (!status || task.status === status) &&
        (!assignee || task.assignee === assignee) &&
        (!initiative || task.initiativeId === initiative) &&
        (!capsule || task.capsuleId === capsule)
      );
      if (tasks.length === 0) return "No tasks found.";
      return tasks.map((task) => formatTaskLine(state, task)).join("\n") + `\n\n${tasks.length} task(s)`;
    }
    if (cmd === "get") {
      const lookup = lookupTask(state, args[1]);
      if (!lookup.task) return lookup.error;
      return JSON.stringify(lookup.task, null, 2);
    }
    if (cmd === "create") {
      const title = stripOptions(args.slice(1), ["--assign", "--assignee", "--priority", "--parent", "--after", "--path", "--pattern", "--desc", "--initiative", "--capsule", "--subsystem", "--profile", "--owner-role", "--reviewer-role", "--acceptance", "--blocked-by"]).join(" ").trim();
      if (!title) return "usage: king task create <title> [--assign agent-id] [--priority 1-10] [--after id1,id2] [--path a,b] [--pattern a,b] [--desc text]";
      const now = Date.now();
      const task: Task = {
        id: `task-${now}-${Math.random().toString(36).slice(2)}`,
        title,
        description: readOption(args, "--desc"),
        status: readOption(args, "--assign") || readOption(args, "--assignee") ? "assigned" : "pending",
        assignee: readOption(args, "--assign") || readOption(args, "--assignee"),
        ownerRole: readOption(args, "--owner-role"),
        reviewerRole: readOption(args, "--reviewer-role"),
        priority: normalizePriority(readOption(args, "--priority")),
        parentId: readOption(args, "--parent"),
        dependsOn: parseCsvOption(args, "--after"),
        blockedBy: parseCsvOption(args, "--blocked-by"),
        acceptance: parseCsvOption(args, "--acceptance"),
        initiativeId: readOption(args, "--initiative"),
        capsuleId: readOption(args, "--capsule"),
        subsystem: readOption(args, "--subsystem"),
        scope: taskScopeFromArgs(args),
        executionProfile: readOption(args, "--profile"),
        created_at: now,
        updated_at: now
      };
      const conflicts = taskScopeConflicts(state, task, task.assignee);
      state.tasks.push(task);
      return `Task ${task.id} created: "${task.title}" [${task.status}]` +
        (conflicts.length ? `\nWarnings: ${conflicts.join("; ")}` : "");
    }
    if (cmd === "update") {
      const lookup = lookupTask(state, args[1]);
      if (!lookup.task) return lookup.error;
      const task = lookup.task;
      const status = readOption(args, "--status");
      if (status && !isTaskStatus(status)) return `invalid task status: ${status}`;
      const nextStatus: TaskStatus = status && isTaskStatus(status) ? status : task.status;
      const previousStatus = task.status;
      task.status = nextStatus;
      task.assignee = readOption(args, "--assign") || readOption(args, "--assignee") || task.assignee;
      task.ownerRole = readOption(args, "--owner-role") ?? task.ownerRole;
      task.reviewerRole = readOption(args, "--reviewer-role") ?? task.reviewerRole;
      task.blockedBy = parseCsvOption(args, "--blocked-by") ?? task.blockedBy;
      task.acceptance = parseCsvOption(args, "--acceptance") ?? task.acceptance;
      task.result = readOption(args, "--result") ?? task.result;
      applyTaskReviewPayload(task, {
        reviewResult: readOption(args, "--review"),
        revisionReason: readOption(args, "--reason"),
        artifactIds: parseCsvOption(args, "--artifact") ?? parseCsvOption(args, "--artifacts")
      }, actor);
      task.initiativeId = readOption(args, "--initiative") ?? task.initiativeId;
      task.capsuleId = readOption(args, "--capsule") ?? task.capsuleId;
      task.subsystem = readOption(args, "--subsystem") ?? task.subsystem;
      task.executionProfile = readOption(args, "--profile") ?? task.executionProfile;
      const scope = taskScopeFromArgs(args);
      task.scope = scope ? { ...(task.scope ?? {}), ...scope } : task.scope;
      task.updated_at = Date.now();
      if (previousStatus !== task.status) {
        pushLoopEvent(state, {
          type: "task.transition",
          agent: task.assignee,
          taskId: task.id,
          from: previousStatus,
          to: task.status
        });
      }
      return `Task ${task.id} updated [${task.status}]`;
    }
    if (cmd === "done") {
      const lookup = lookupTask(state, args[1]);
      if (!lookup.task) return lookup.error;
      const task = lookup.task;
      const review = readOption(args, "--review");
      const reason = readOption(args, "--reason");
      const artifactIds = parseCsvOption(args, "--artifact") ?? parseCsvOption(args, "--artifacts");
      const resultText = stripOptions(args.slice(2), ["--review", "--reason", "--artifact", "--artifacts"]).join(" ").trim();
      if (review && review !== "approved" && review !== "changes_requested") return "invalid review result: use approved or changes_requested";
      if (review === "changes_requested") {
        task.reviewResult = "changes_requested";
        task.revisionReason = reason || resultText || "Reviewer requested revisions.";
        if (artifactIds?.length) task.artifactIds = artifactIds;
        task.reviewedByAgentId = actor.id;
        task.reviewedAt = Date.now();
        const previousStatus = task.status;
        const conversation = task.conversationId ? ensureConversation(state, task.conversationId) : undefined;
        const worker = conversation ? workerAgentForConversation(state, conversation) : defaultWorkerAgentFor(state);
        task.status = "assigned";
        task.assignee = worker?.id ?? defaultWorkerAgentFor(state).id;
        task.updated_at = Date.now();
        if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
        queueTaskChangesRequestedMessage(state, task, task.assignee);
        return `Task ${task.id} returned to ${task.assignee}: ${task.revisionReason}`;
      }
      if (artifactIds?.length) task.artifactIds = artifactIds;
      if (review === "approved") task.reviewResult = "approved";
      return advanceTaskDone(state, task, actor, resultText);
    }
    return "usage: king task create|list|get|update|done";
  }

  private initiativeCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const status = readOption(args, "--status");
      const initiatives = state.initiatives.filter((initiative) => !status || initiative.status === status);
      if (initiatives.length === 0) return "No initiatives found.";
      return initiatives.map((initiative) => formatInitiativeLine(state, initiative)).join("\n") + `\n\n${initiatives.length} initiative(s)`;
    }
    if (cmd === "get") {
      const initiative = findInitiative(state, args[1]);
      return initiative ? JSON.stringify({
        ...initiative,
        taskCount: state.tasks.filter((task) => task.initiativeId === initiative.id).length,
        capsuleCount: state.capsules.filter((capsule) => capsule.initiativeId === initiative.id).length
      }, null, 2) : `initiative not found: ${args[1] || ""}`;
    }
    if (cmd === "create") {
      const title = stripOptions(args.slice(1), ["--goal", "--summary", "--priority", "--source", "--status", "--agent"]).join(" ").trim();
      const goal = readOption(args, "--goal");
      const status = readOption(args, "--status") || "active";
      if (!title || !goal) return "usage: king initiative create <title> --goal <goal> [--summary text] [--priority 1-10] [--source a,b]";
      if (!isInitiativeStatus(status)) return `invalid initiative status: ${status}`;
      const now = Date.now();
      const initiative: Initiative = {
        id: `initiative-${now}-${Math.random().toString(36).slice(2)}`,
        title,
        goal,
        summary: readOption(args, "--summary"),
        status,
        priority: normalizePriority(readOption(args, "--priority")),
        sources: parseCsvOption(args, "--source"),
        agentId: readOption(args, "--agent") || DEFAULT_AGENT.id,
        created_at: now,
        updated_at: now
      };
      state.initiatives.push(initiative);
      return `Initiative ${initiative.id} created: "${initiative.title}" [${initiative.status}]`;
    }
    if (cmd === "update") {
      const initiative = findInitiative(state, args[1]);
      if (!initiative) return `initiative not found: ${args[1] || ""}`;
      const status = readOption(args, "--status");
      if (status && !isInitiativeStatus(status)) return `invalid initiative status: ${status}`;
      initiative.title = readOption(args, "--title") ?? initiative.title;
      initiative.goal = readOption(args, "--goal") ?? initiative.goal;
      initiative.summary = readOption(args, "--summary") ?? initiative.summary;
      initiative.status = status && isInitiativeStatus(status) ? status : initiative.status;
      initiative.priority = readOption(args, "--priority") ? normalizePriority(readOption(args, "--priority")) : initiative.priority;
      initiative.sources = parseCsvOption(args, "--source") ?? initiative.sources;
      initiative.updated_at = Date.now();
      return `Initiative ${initiative.id} updated [${initiative.status}]`;
    }
    return "usage: king initiative create|list|get|update";
  }

  private capsuleCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const status = readOption(args, "--status");
      const owner = readOption(args, "--owner");
      const reviewer = readOption(args, "--reviewer");
      const initiative = readOption(args, "--initiative");
      const capsules = state.capsules.filter((capsule) =>
        (!status || capsule.status === status) &&
        (!owner || capsule.ownerAgent === owner) &&
        (!reviewer || capsule.reviewer === reviewer) &&
        (!initiative || capsule.initiativeId === initiative)
      );
      if (capsules.length === 0) return "No capsules found.";
      return capsules.map(formatCapsuleLine).join("\n") + `\n\n${capsules.length} capsule(s)`;
    }
    if (cmd === "mine") {
      const agent = readOption(args, "--agent") || DEFAULT_AGENT.id;
      const status = readOption(args, "--status");
      const capsules = state.capsules.filter((capsule) =>
        capsule.ownerAgent === agent &&
        (!status || capsule.status === status)
      );
      if (capsules.length === 0) return "No owned capsules found.";
      return capsules.map((capsule) => `${formatCapsuleLine(capsule)}\n  acceptance: ${capsule.acceptance}`).join("\n");
    }
    if (cmd === "get") {
      const capsule = findCapsule(state, args[1]);
      return capsule ? JSON.stringify(capsule, null, 2) : `capsule not found: ${args[1] || ""}`;
    }
    if (cmd === "create") {
      const goal = readOption(args, "--goal") || stripOptions(args.slice(1), ["--owner", "--branch", "--base", "--paths", "--path", "--acceptance", "--reviewer", "--initiative", "--task", "--subsystem", "--scope-type", "--blocked-by", "--supersedes"]).join(" ").trim();
      const ownerAgent = readOption(args, "--owner") || DEFAULT_AGENT.id;
      const branch = readOption(args, "--branch") || `king/${ownerAgent}/${Date.now()}`;
      const baseCommit = readOption(args, "--base") || "unknown";
      const allowedPaths = parseAllowedPaths(args);
      const acceptance = readOption(args, "--acceptance") || "Owner documents the change and required verification.";
      const scopeType = readOption(args, "--scope-type");
      if (!goal || allowedPaths.length === 0) return "usage: king capsule create --goal <goal> --paths a,b [--owner agent-id] [--branch name] [--base sha] [--acceptance text]";
      if (scopeType && !isCapsuleScopeType(scopeType)) return `invalid capsule scope type: ${scopeType}`;
      const now = Date.now();
      const capsule: ChangeCapsule = {
        id: `capsule-${now}-${Math.random().toString(36).slice(2)}`,
        goal,
        ownerAgent,
        branch,
        baseCommit,
        allowedPaths,
        acceptance,
        reviewer: readOption(args, "--reviewer"),
        status: "open",
        initiativeId: readOption(args, "--initiative"),
        taskId: readOption(args, "--task"),
        subsystem: readOption(args, "--subsystem"),
        scopeType: scopeType && isCapsuleScopeType(scopeType) ? scopeType : undefined,
        blockedBy: parseCsvOption(args, "--blocked-by"),
        supersedes: readOption(args, "--supersedes"),
        created_at: now,
        updated_at: now
      };
      const conflicts = capsuleConflicts(state, capsule);
      state.capsules.push(capsule);
      return `Capsule ${capsule.id} created on ${capsule.branch} [${capsule.status}]` +
        (conflicts.length ? `\nConflicts: ${conflicts.map((conflict) => `${conflict.id.slice(0, 14)}(${conflict.level})`).join(", ")}` : "");
    }
    if (cmd === "update") {
      const capsule = findCapsule(state, args[1]);
      if (!capsule) return `capsule not found: ${args[1] || ""}`;
      const status = readOption(args, "--status");
      const scopeType = readOption(args, "--scope-type");
      if (status && !isCapsuleStatus(status)) return `invalid capsule status: ${status}`;
      if (scopeType && !isCapsuleScopeType(scopeType)) return `invalid capsule scope type: ${scopeType}`;
      capsule.goal = readOption(args, "--goal") ?? capsule.goal;
      capsule.ownerAgent = readOption(args, "--owner") ?? capsule.ownerAgent;
      capsule.branch = readOption(args, "--branch") ?? capsule.branch;
      capsule.baseCommit = readOption(args, "--base") ?? capsule.baseCommit;
      capsule.acceptance = readOption(args, "--acceptance") ?? capsule.acceptance;
      capsule.reviewer = readOption(args, "--reviewer") ?? capsule.reviewer;
      capsule.status = status && isCapsuleStatus(status) ? status : capsule.status;
      capsule.initiativeId = readOption(args, "--initiative") ?? capsule.initiativeId;
      capsule.taskId = readOption(args, "--task") ?? capsule.taskId;
      capsule.subsystem = readOption(args, "--subsystem") ?? capsule.subsystem;
      capsule.scopeType = scopeType && isCapsuleScopeType(scopeType) ? scopeType : capsule.scopeType;
      capsule.blockedBy = parseCsvOption(args, "--blocked-by") ?? capsule.blockedBy;
      capsule.supersedes = readOption(args, "--supersedes") ?? capsule.supersedes;
      const allowedPaths = parseAllowedPaths(args);
      if (allowedPaths.length) capsule.allowedPaths = allowedPaths;
      capsule.updated_at = Date.now();
      return `Capsule ${capsule.id} updated [${capsule.status}]`;
    }
    return "usage: king capsule create|list|mine|get|update";
  }

  private mergeCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const status = readOption(args, "--status");
      const rows = state.mergeQueue.filter((request) => !status || request.status === status);
      if (rows.length === 0) return "No merge requests found.";
      return rows.map(formatMergeRequestLine).join("\n") + `\n\n${rows.length} merge request(s)`;
    }
    if (cmd === "get") {
      const request = findMergeRequest(state, args[1]);
      return request ? JSON.stringify(request, null, 2) : `merge request not found: ${args[1] || ""}`;
    }
    if (cmd === "enqueue") {
      const capsule = findCapsule(state, readOption(args, "--capsule"));
      const branch = readOption(args, "--branch") || capsule?.branch;
      const taskId = readOption(args, "--task") || capsule?.taskId;
      const agentId = readOption(args, "--agent") || capsule?.ownerAgent || DEFAULT_AGENT.id;
      const targetBranch = readOption(args, "--target") || "main";
      if (!branch) return "usage: king merge enqueue --branch <name> [--task id] [--capsule id] [--agent id] [--target main]";
      if (!isSafeBranchName(branch) || !isSafeBranchName(targetBranch)) return `invalid branch name: ${branch}`;
      const existing = state.mergeQueue.find((request) => request.branch === branch && request.status !== "merged" && request.status !== "failed");
      if (existing) return `merge request already queued ${existing.id}`;
      const now = Date.now();
      const request: MergeRequest = {
        id: `merge-${now}-${Math.random().toString(36).slice(2)}`,
        taskId,
        capsuleId: capsule?.id || readOption(args, "--capsule"),
        branch,
        agentId,
        targetBranch,
        status: "queued",
        createdAt: now,
        updatedAt: now
      };
      state.mergeQueue.push(request);
      if (capsule && capsule.status === "open") {
        capsule.status = "in_review";
        capsule.updated_at = now;
      }
      return `merge queued ${request.id} branch=${request.branch} target=${request.targetBranch}`;
    }
    if (cmd === "mark") {
      const request = findMergeRequest(state, args[1]);
      const status = args[2];
      if (!request) return `merge request not found: ${args[1] || ""}`;
      if (!isMergeStatus(status)) return "usage: king merge mark <id> queued|testing|merged|conflict|failed [--error text]";
      request.status = status;
      request.updatedAt = Date.now();
      request.error = readOption(args, "--error") ?? request.error;
      if (status === "merged") {
        request.mergedAt = request.updatedAt;
        const capsule = findCapsule(state, request.capsuleId);
        if (capsule) {
          capsule.status = "merged";
          capsule.updated_at = request.updatedAt;
        }
        const task = lookupTask(state, request.taskId).task;
        if (task) {
          task.status = "done";
          task.result = task.result || `merged via ${request.id}`;
          task.updated_at = request.updatedAt;
        }
      }
      return `merge ${request.id} marked ${request.status}${request.error ? ` error=${request.error}` : ""}`;
    }
    return "usage: king merge enqueue|list|get|mark";
  }

  private evalCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const approvalOnly = args.includes("--approval-required");
      const rows = state.evaluations.filter((evaluation) => !approvalOnly || evaluation.requiresHumanApproval);
      if (rows.length === 0) return "No evaluations found.";
      return rows.map(formatEvaluationLine).join("\n") + `\n\n${rows.length} evaluation(s)`;
    }
    if (cmd === "get") {
      const evaluation = findEvaluation(state, args[1]);
      return evaluation ? JSON.stringify(evaluation, null, 2) : `evaluation not found: ${args[1] || ""}`;
    }
    if (cmd !== "parse" && cmd !== "record") return "usage: king eval parse|record|list|get '<json evaluation>' [--artifact id] [--initiative id]";
    let evaluation: EvaluationRecord;
    try {
      evaluation = parseEvaluationRecord(firstJsonArg(args.slice(1)) || "", {
        artifactId: readOption(args, "--artifact"),
        initiativeId: readOption(args, "--initiative")
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (cmd === "record") {
      state.evaluations.push(evaluation);
      return `evaluation recorded ${evaluation.id} selected=${evaluation.selectedOptionId} requiresApproval=${evaluation.requiresHumanApproval}`;
    }
    return formatEvaluationSummary(evaluation);
  }

  private feedbackCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const agent = readOption(args, "--agent");
      const errored = readBooleanOption(args, "--errored");
      const completed = readBooleanOption(args, "--completed");
      const rows = state.runFeedback.filter((feedback) =>
        (!agent || feedback.agentId === agent) &&
        (errored === undefined || feedback.errored === errored) &&
        (completed === undefined || feedback.taskCompleted === completed)
      );
      if (rows.length === 0) return "No run feedback found.";
      return rows.map(formatRunFeedbackLine).join("\n") + `\n\n${rows.length} feedback record(s)`;
    }
    if (cmd === "get") {
      const feedback = findRunFeedback(state, args[1]);
      return feedback ? JSON.stringify(feedback, null, 2) : `feedback not found: ${args[1] || ""}`;
    }
    if (cmd === "summary") {
      const agent = readOption(args, "--agent");
      const rows = state.runFeedback.filter((feedback) => !agent || feedback.agentId === agent);
      if (rows.length === 0) return "No run feedback found.";
      return summarizeRunFeedback(rows).map(formatRunFeedbackSummaryLine).join("\n");
    }
    if (cmd === "record") {
      const feedback = parseRunFeedback(args);
      state.runFeedback.push(feedback);
      return `feedback recorded ${feedback.id} agent=${feedback.agentId} completed=${feedback.taskCompleted} errored=${feedback.errored}`;
    }
    return "usage: king feedback record|list|summary|get [--agent agent-id] [--completed true|false]";
  }

  private reviewCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const decision = readOption(args, "--decision");
      const reviewer = readOption(args, "--reviewer");
      const capsuleId = readOption(args, "--capsule");
      const rows = state.reviews.filter((review) =>
        (!decision || review.decision === decision) &&
        (!reviewer || review.reviewer === reviewer) &&
        (!capsuleId || review.capsuleId === capsuleId || review.capsuleId.startsWith(capsuleId))
      );
      if (rows.length === 0) return "No reviews found.";
      return rows.map(formatReviewLine).join("\n") + `\n\n${rows.length} review(s)`;
    }
    if (cmd === "get") {
      const review = findReview(state, args[1]);
      return review ? JSON.stringify(review, null, 2) : `review not found: ${args[1] || ""}`;
    }
    if (cmd === "record") {
      const capsule = findCapsule(state, readOption(args, "--capsule"));
      if (!capsule) return "usage: king review record --capsule <id> --coverage <pct> [--checks true|false] [--acceptance true|false] [--scope true|false] [--tests true|false] [--regressions true|false]";
      const review = parseReviewRecord(args, capsule);
      state.reviews.push(review);
      if (review.decision === "approved") {
        capsule.status = "in_review";
        capsule.updated_at = review.createdAt;
        const mergeId = readOption(args, "--merge");
        const merge = findMergeRequest(state, mergeId);
        if (merge && merge.status === "queued") {
          merge.status = "testing";
          merge.updatedAt = review.createdAt;
        }
      }
      return `review recorded ${review.id} capsule=${review.capsuleId} decision=${review.decision}${review.reasons.length ? ` reasons=${review.reasons.join("; ")}` : ""}`;
    }
    return "usage: king review record|list|get [--capsule id] [--coverage pct] [--checks true|false]";
  }

  private routeCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const eventType = args[1] || readOption(args, "--type");
      const rows = state.eventRoutes.filter((route) => !eventType || route.eventType === eventType);
      if (rows.length === 0) return "No event routes found.";
      return rows.map(formatEventRouteLine).join("\n") + `\n\n${rows.length} route(s)`;
    }
    if (cmd === "set") {
      const eventType = args[1];
      const agentId = readOption(args, "--agent") || args[2] || DEFAULT_AGENT.id;
      if (!eventType) return "usage: king route set <eventType> --agent <agentId>";
      if (!state.agents.some((agent) => agent.id === agentId)) state.agents.push({ ...DEFAULT_AGENT, id: agentId, name: agentId, role: "Event subscriber" });
      if (!state.eventRoutes.some((route) => route.eventType === eventType && route.agentId === agentId)) {
        state.eventRoutes.push({ eventType, agentId, createdAt: Date.now() });
      }
      for (const agent of state.agents.filter((agent) => agent.id === agentId)) {
        agent.events = [...new Set([...(agent.events ?? []), eventType])];
      }
      return `route set ${eventType} -> ${agentId}`;
    }
    if (cmd === "delete" || cmd === "remove") {
      const eventType = args[1];
      const agentId = readOption(args, "--agent") || args[2];
      if (!eventType) return "usage: king route delete <eventType> [--agent <agentId>]";
      const before = state.eventRoutes.length;
      state.eventRoutes = state.eventRoutes.filter((route) => route.eventType !== eventType || (agentId && route.agentId !== agentId));
      for (const agent of state.agents) {
        if (!agentId || agent.id === agentId) agent.events = (agent.events ?? []).filter((event) => event !== eventType);
      }
      return state.eventRoutes.length < before ? `route deleted ${eventType}${agentId ? ` -> ${agentId}` : ""}` : `route not found: ${eventType}`;
    }
    if (cmd === "emit") {
      const eventType = args[1];
      if (!eventType) return "usage: king route emit <eventType> [--source source] '<payload json>'";
      const event = parseExternalEventArgs(eventType, args.slice(2));
      const routed = routeExternalEvent(state, event);
      for (const agentId of routed) {
        pushLoopEvent(state, {
          type: "queue.backlog",
          agent: agentId,
          pendingMessages: countPendingMessages(state, agentId),
          payload: event
        });
      }
      return routed.length
        ? `event routed ${event.type} -> ${routed.join(",")}`
        : `event ignored ${event.type}: no subscribers`;
    }
    return "usage: king route set|list|delete|emit <eventType> [--agent agent-id] [--source source] '<payload json>'";
  }

  private calendarCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") return JSON.stringify(state.calendar, null, 2);
    if (cmd === "create") {
      const title = args[1] || "Untitled reminder";
      const atIdx = args.indexOf("--at");
      const assigneeIdx = args.indexOf("--assignee");
      const promptIdx = args.indexOf("--prompt");
      const cron = readOption(args, "--cron");
      if (cron) {
        try {
          parseCron(cron);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }
      const item: CalendarItem = {
        id: `cal-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        at: atIdx >= 0 && args[atIdx + 1] ? args[atIdx + 1] : new Date().toISOString(),
        cron,
        assignee: assigneeIdx >= 0 && args[assigneeIdx + 1] ? args[assigneeIdx + 1] : DEFAULT_AGENT.id,
        prompt: promptIdx >= 0 && args[promptIdx + 1] ? args[promptIdx + 1] : undefined,
        created_at: Date.now()
      };
      state.calendar.push(item);
      return `calendar created ${item.id}${cron ? ` cron=${cron}` : ""}`;
    }
    return "usage: king calendar list|create <title> --at <iso> [--cron expr] [--assignee <id>] [--prompt <text>]";
  }

  private claimCommand(state: State, args: string[]): string {
    const name = args[0] || "work";
    const inIdx = args.indexOf("--in");
    const conversationId = inIdx >= 0 ? args[inIdx + 1] : undefined;
    const owner = readOption(args, "--owner") || DEFAULT_AGENT.id;
    const allowedPaths = parseAllowedPaths(args);
    const conflict = pathConflict(state, allowedPaths, owner);
    if (conflict) return `path conflict: ${conflict}`;
    const existing = state.claims.find((claim) => claim.name === name && claim.conversationId === conversationId);
    if (existing && existing.owner !== owner) return `claim held by ${existing.owner}`;
    if (existing) return `claim already held ${existing.id}`;
    const claim: Claim = {
      id: `claim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      conversationId,
      owner,
      allowedPaths,
      created_at: Date.now()
    };
    state.claims.push(claim);
    return `claim created ${claim.id}${allowedPaths.length ? ` paths=${allowedPaths.join(",")}` : ""}`;
  }

  private unclaimCommand(state: State, args: string[]): string {
    const id = args[0];
    const before = state.claims.length;
    state.claims = state.claims.filter((claim) => claim.id !== id && claim.name !== id);
    return state.claims.length < before ? "claim released" : `claim not found: ${id}`;
  }

  private dmCommand(state: State, args: string[]): string {
    const target = args[0] || DEFAULT_AGENT.id;
    const body = args.slice(1).join(" ").trim() || "(empty dm)";
    const message = this.newAgentMessage({
      target,
      fromId: DEFAULT_AGENT.id,
      fromName: DEFAULT_AGENT.name,
      fromKind: "agent",
      fromEngine: DEFAULT_AGENT.engine,
      body,
      priority: "normal",
      messageType: "message"
    });
    message.readBy.push(DEFAULT_AGENT.id);
    state.messages.push(message);
    return `dm posted ${message.conversation_id}`;
  }

  private sendCommand(state: State, args: string[]): string {
    const target = args[0];
    const messageType = readOption(args, "--type") || "message";
    if (messageType !== "message" && messageType !== "decision" && messageType !== "blocker") {
      return "usage: king send <agentId> <message> [--steer] [--type message|decision|blocker]";
    }
    const body = stripOptions(args.slice(1), ["--type"]).filter((arg) => arg !== "--steer").join(" ").trim();
    if (!target || !body) return "usage: king send <agentId> <message> [--steer] [--type message|decision|blocker]";
    const message = this.newAgentMessage({
      target,
      fromId: DEFAULT_AGENT.id,
      fromName: DEFAULT_AGENT.name,
      fromKind: "agent",
      fromEngine: DEFAULT_AGENT.engine,
      body,
      priority: args.includes("--steer") ? "steer" : "normal",
      messageType
    });
    state.messages.push(message);
    return `Message ${message.id} queued -> ${target} (${messageType}, ${message.priority})`;
  }

  private recvCommand(state: State, args: string[]): string {
    const agentId = readOption(args, "--agent") || DEFAULT_AGENT.id;
    const routedRows = sortRuntimeMessages(
      state.messages.filter((message) => isRuntimeVisibleMessage(message) && (!message.to_agent_id || message.to_agent_id === agentId) && !message.readBy.includes(agentId)),
      agentId
    )
      .slice(0, 10);
    if (routedRows.length === 0) return "No pending messages.";
    for (const routed of routedRows) routed.row.readBy.push(agentId);
    return routedRows.map((routed) => {
      const row = routed.row;
      return `[${messageRouteTag(routed)}] ${row.author_name} (${new Date(row.created_at).toISOString()}): ${row.body}`;
    }).join("\n");
  }

  private escalateCommand(state: State, args: string[]): string {
    const body = args.join(" ").trim();
    if (!body) return "usage: king escalate <message>";
    const target = state.agents.find((agent) => agent.id === "ceo" || agent.name.toLowerCase().includes("ceo"))?.id ?? DEFAULT_AGENT.id;
    const message = this.newAgentMessage({
      target,
      fromId: DEFAULT_AGENT.id,
      fromName: DEFAULT_AGENT.name,
      fromKind: "agent",
      fromEngine: DEFAULT_AGENT.engine,
      body,
      priority: "steer",
      messageType: "decision"
    });
    state.messages.push(message);
    return `Escalated to ${target}: ${message.id} (queued)`;
  }

  private reactCommand(state: State, args: string[]): string {
    const messageId = args[0];
    const emoji = args[1] || "(ok)";
    if (!messageId) return "usage: king react <messageId> <emoji>";
    state.reactions.push({ messageId, emoji, authorId: DEFAULT_AGENT.id, created_at: Date.now() });
    return `reaction posted ${messageId} ${emoji}`;
  }

  private docCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") return JSON.stringify(state.docs, null, 2);
    if (cmd === "show") {
      const id = args[1];
      const doc = state.docs.find((row) => row.id === id);
      return doc ? `${doc.title}\n\n${doc.body}` : `doc not found: ${id}`;
    }
    if (cmd === "append") {
      const id = args[1];
      const doc = state.docs.find((row) => row.id === id);
      if (!doc) return `doc not found: ${id}`;
      const extra = args.slice(2).join(" ").trim();
      doc.body = doc.body ? `${doc.body}\n${extra}` : extra;
      return `doc appended ${doc.id}`;
    }
    if (cmd === "update") {
      const id = args[1];
      const doc = state.docs.find((row) => row.id === id);
      if (!doc) return `doc not found: ${id}`;
      doc.body = args.slice(2).join(" ").trim();
      return `doc updated ${doc.id}`;
    }
    if (cmd === "create") {
      const title = args[1] || "Untitled doc";
      const body = args.slice(2).join(" ").trim();
      const doc: Doc = {
        id: `doc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        title,
        body,
        created_at: Date.now()
      };
      state.docs.push(doc);
      return `doc created ${doc.id}`;
    }
    return "usage: king doc list|create|show|append|update";
  }

  private artifactCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const agent = readOption(args, "--agent");
      const kind = readOption(args, "--kind");
      const unverified = args.includes("--unverified");
      const rows = state.artifacts.filter((artifact) =>
        (!agent || artifact.agentId === agent) &&
        (!kind || artifact.kind === kind) &&
        (!unverified || !artifact.verified)
      );
      if (rows.length === 0) return "No artifacts found.";
      return rows.map(formatArtifactLine).join("\n") + `\n\n${rows.length} artifact(s)`;
    }
    if (cmd === "get") {
      const artifact = findArtifact(state, args[1]);
      return artifact ? JSON.stringify(artifact, null, 2) : `artifact not found: ${args[1] || ""}`;
    }
    if (cmd === "check") {
      const existing = findArtifact(state, args[1]);
      const candidate = existing ?? artifactCandidateFromArgs(args);
      if (!candidate) return "usage: king artifact check <id> OR king artifact check --kind <kind> --path <domain/category/item> --source <source> --confidence <0-1>";
      const check = checkArtifactQuality(candidate);
      return formatArtifactQualityCheck(check);
    }
    if (cmd === "put") {
      const kind = readOption(args, "--kind");
      const path = readOption(args, "--path");
      const source = readOption(args, "--source");
      const confidence = Number.parseFloat(readOption(args, "--confidence") || "");
      if (!kind || !path || !source || !Number.isFinite(confidence)) {
        return "usage: king artifact put --kind <kind> --path <domain/category/item> --source <source> --confidence <0-1> [--task id] [--content text] '<metadata json>'";
      }
      if (confidence < 0 || confidence > 1) return "artifact confidence must be between 0 and 1";
      const allowNonstandard = args.includes("--allow-nonstandard");
      if (!STANDARD_ARTIFACT_KINDS.has(kind) && !allowNonstandard) {
        return `non-standard artifact kind: ${kind}. Use --allow-nonstandard to store it anyway.`;
      }
      const metadata = parseMetadataJson(args) ?? {};
      if (!STANDARD_ARTIFACT_KINDS.has(kind)) metadata.non_standard_kind = true;
      const quality = checkArtifactQuality({ kind, path, source, confidence, metadata, content: readOption(args, "--content") });
      if (quality.warnings.length) metadata.quality_warnings = quality.warnings;
      metadata.quality_score = quality.score;
      const artifact: Artifact = {
        id: `artifact-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind,
        path,
        source,
        confidence,
        agentId: readOption(args, "--agent") || DEFAULT_AGENT.id,
        taskId: readOption(args, "--task"),
        content: readOption(args, "--content"),
        metadata,
        verified: confidence >= 0.8,
        created_at: Date.now()
      };
      state.artifacts.push(artifact);
      pushLoopEvent(state, {
        type: "artifact.created",
        agent: artifact.agentId,
        taskId: artifact.taskId,
        kind: artifact.kind,
        path: artifact.path,
        payload: { artifactId: artifact.id, confidence: artifact.confidence, verified: artifact.verified }
      });
      return `artifact stored ${artifact.id} kind=${artifact.kind} source=${artifact.source} confidence=${artifact.confidence}${quality.warnings.length ? ` warnings=${quality.warnings.length}` : ""}`;
    }
    return "usage: king artifact put|list|get|check";
  }

  private contextCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      if (state.context.length === 0) return "No context entries found.";
      return state.context
        .slice()
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((entry) => `${entry.key}\t${entry.value}\tupdatedBy=${entry.updatedBy}`)
        .join("\n");
    }
    if (cmd === "get") {
      const key = args[1];
      if (!key) return "usage: king context get <key>";
      const entry = state.context.find((row) => row.key === key);
      return entry ? entry.value : `Key "${key}" not found.`;
    }
    if (cmd === "set") {
      const key = args[1];
      const value = stripOptions(args.slice(2), ["--agent"]).join(" ").trim();
      if (!key || !value) return "usage: king context set <key> <value>";
      const updatedBy = readOption(args, "--agent") || DEFAULT_AGENT.id;
      const existing = state.context.find((row) => row.key === key);
      if (existing) {
        existing.value = value;
        existing.updatedBy = updatedBy;
        existing.updatedAt = Date.now();
      } else {
        state.context.push({ key, value, updatedBy, updatedAt: Date.now() });
      }
      return `Set "${key}" = "${value}"`;
    }
    if (cmd === "delete" || cmd === "unset") {
      const key = args[1];
      if (!key) return "usage: king context delete <key>";
      const before = state.context.length;
      state.context = state.context.filter((row) => row.key !== key);
      return state.context.length < before ? `Deleted "${key}"` : `Key "${key}" not found.`;
    }
    return "usage: king context get|set|list|delete <key> [value]";
  }

  private hypothesisCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "list") {
      const status = readOption(args, "--status");
      const treeRoot = readOption(args, "--tree");
      const rows = state.hypotheses.filter((hypothesis) =>
        (!status || hypothesis.status === status) &&
        (!treeRoot || hypothesis.id === treeRoot || hypothesis.parentId === treeRoot)
      );
      if (rows.length === 0) return "No hypotheses found.";
      return rows.map(formatHypothesisLine).join("\n") + `\n\n${rows.length} hypothesis(es)`;
    }
    if (cmd === "create") {
      const title = stripOptions(args.slice(1), ["--rationale", "--expected-value", "--estimated-cost", "--parent", "--agent"]).join(" ").trim();
      if (!title) return "usage: king hypothesis create <title> [--rationale text] [--expected-value text] [--estimated-cost text] [--parent id]";
      const now = Date.now();
      const hypothesis: Hypothesis = {
        id: `hyp-${now}-${Math.random().toString(36).slice(2)}`,
        title,
        status: "proposed",
        agentId: readOption(args, "--agent") || DEFAULT_AGENT.id,
        parentId: readOption(args, "--parent"),
        rationale: readOption(args, "--rationale"),
        expectedValue: readOption(args, "--expected-value"),
        estimatedCost: readOption(args, "--estimated-cost"),
        created_at: now,
        updated_at: now
      };
      state.hypotheses.push(hypothesis);
      return `Hypothesis ${hypothesis.id} created: ${hypothesis.title}`;
    }
    if (cmd === "update") {
      const hypothesis = findHypothesis(state, args[1]);
      if (!hypothesis) return `hypothesis not found: ${args[1] || ""}`;
      const status = readOption(args, "--status");
      if (status && !isHypothesisStatus(status)) return `invalid hypothesis status: ${status}`;
      const nextStatus: HypothesisStatus = status && isHypothesisStatus(status) ? status : hypothesis.status;
      hypothesis.status = nextStatus;
      hypothesis.outcome = readOption(args, "--outcome") ?? hypothesis.outcome;
      hypothesis.evidenceArtifactIds = parseCsvOption(args, "--evidence") ?? hypothesis.evidenceArtifactIds;
      hypothesis.updated_at = Date.now();
      return `Hypothesis ${hypothesis.id} updated: status=${hypothesis.status}`;
    }
    return "usage: king hypothesis create|list|update";
  }

  private planCommand(state: State, args: string[]): string {
    const cmd = args[0] || "parse";
    if (cmd !== "parse" && cmd !== "apply") return "usage: king plan parse|apply '<json plan>' [--assign agent-id] [--initiative id]";
    let plan: ExecutionPlan;
    try {
      plan = parseExecutionPlan(args.slice(1).find((arg) => !arg.startsWith("--")) || "");
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    if (cmd === "parse") {
      return [
        `plan ${plan.optionId}: ${plan.tasks.length} task(s), estimatedTokens=${plan.totalEstimatedTokens}`,
        ...plan.tasks.map((task) => `- P${task.priority} ${task.title} paths=${task.scope.paths.join(",") || "none"} after=${task.dependencies.join(",") || "none"}`)
      ].join("\n");
    }

    const assign = readOption(args, "--assign") || readOption(args, "--assignee") || DEFAULT_AGENT.id;
    const initiativeId = readOption(args, "--initiative");
    const byTitle = new Map<string, string>();
    const created: Task[] = [];
    for (const planned of plan.tasks) {
      const now = Date.now();
      const task: Task = {
        id: `task-${now}-${Math.random().toString(36).slice(2)}`,
        title: planned.title,
        description: planned.description,
        status: assign ? "assigned" : "pending",
        assignee: assign,
        priority: planned.priority,
        dependsOn: planned.dependencies.map((title) => byTitle.get(title) || title).filter(Boolean),
        initiativeId,
        scope: planned.scope,
        executionProfile: `plan:${plan.optionId}`,
        created_at: now,
        updated_at: now
      };
      state.tasks.push(task);
      created.push(task);
      byTitle.set(planned.title, task.id);
    }
    return [
      `plan applied ${plan.optionId}: ${created.length} task(s) created`,
      ...created.map((task) => `- ${task.id} "${task.title}"${task.dependsOn?.length ? ` after=${task.dependsOn.map((id) => id.slice(0, 10)).join(",")}` : ""}`)
    ].join("\n");
  }

  private safetyCommand(state: State, args: string[]): string {
    const cmd = args[0] || "list";
    if (cmd === "check") {
      const action = args[1];
      if (!isSafetyAction(action)) return `usage: king safety check <action>\nknown actions: ${Array.from(SAFETY_ACTIONS).join(", ")}`;
      return safetyCheck(action).allowed
        ? `allowed: ${action} does not require approval in this gui gate`
        : `approval required: ${action}`;
    }
    if (cmd === "request") {
      const action = args[1];
      if (!isSafetyAction(action)) return "usage: king safety request <action> [--reason text] [--context json]";
      if (safetyCheck(action).allowed) return `allowed: ${action} does not require approval in this gui gate`;
      const context = parseSafetyContext(args);
      const request: ApprovalRequest = {
        id: `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action,
        context,
        status: "pending",
        conversationId: stringContextValue(context, "conversationId"),
        taskId: stringContextValue(context, "taskId"),
        createdAt: Date.now()
      };
      state.approvals.push(request);
      return `approval requested ${request.id} action=${action}`;
    }
    if (cmd === "list" || cmd === "pending") {
      const status = cmd === "pending" ? "pending" : readOption(args, "--status");
      const rows = state.approvals.filter((approval) => !status || approval.status === status);
      if (rows.length === 0) return "No approval requests found.";
      return rows.map(formatApprovalLine).join("\n") + `\n\n${rows.length} approval request(s)`;
    }
    if (cmd === "get") {
      const request = findApproval(state, args[1]);
      return request ? JSON.stringify(request, null, 2) : `approval not found: ${args[1] || ""}`;
    }
    if (cmd === "approve") {
      const request = findApproval(state, args[1]);
      if (!request) return `approval not found: ${args[1] || ""}`;
      if (request.status !== "pending") return `Cannot approve ${request.id}: status=${request.status}`;
      request.status = "approved";
      request.resolvedAt = Date.now();
      return `approval approved ${request.id}`;
    }
    if (cmd === "deny") {
      const request = findApproval(state, args[1]);
      if (!request) return `approval not found: ${args[1] || ""}`;
      if (request.status !== "pending") return `Cannot deny ${request.id}: status=${request.status}`;
      request.status = "denied";
      request.reason = readOption(args, "--reason") || args.slice(2).join(" ").trim() || "denied";
      request.resolvedAt = Date.now();
      return `approval denied ${request.id}: ${request.reason}`;
    }
    return "usage: king safety check|request|list|get|approve|deny <action|approvalId>";
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
    const runId = `run-${Date.now()}`;
    state.loopRunId = runId;
    state.runStreams = { ...(state.runStreams ?? {}), [runId]: initialRunStreamState() };
    state.runLog.push({ at: Date.now(), runId, action: "start", body });
    await this.put(state);
    return json({ runId });
  }

  private async runAction(runId: string, action: "heartbeat" | "finish", body?: unknown): Promise<Response> {
    const state = await this.get();
    const streamEvent = normalizeRunStreamEvent(body);
    if (streamEvent) {
      const current = state.runStreams?.[runId] ?? initialRunStreamState();
      state.runStreams = { ...(state.runStreams ?? {}), [runId]: reduceRunStream(current, streamEvent) };
      state.runLog.push({ at: Date.now(), runId, action: "stream", body: streamEvent, card: renderRunStreamCard(state.runStreams[runId]) });
    }
    if (action === "finish") {
      const current = state.runStreams?.[runId] ?? initialRunStreamState();
      const terminal = body && typeof body === "object" && (body as { status?: unknown }).status === "failed"
        ? reduceRunStream(current, { type: "error", message: typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "run failed" })
        : reduceRunStream(current, { type: "done" });
      state.runStreams = { ...(state.runStreams ?? {}), [runId]: terminal };
      state.runLog.push({ at: Date.now(), runId, action, body, card: renderRunStreamCard(terminal) });
    } else {
      state.runLog.push({ at: Date.now(), runId, action, body, card: state.runStreams?.[runId] ? renderRunStreamCard(state.runStreams[runId]) : undefined });
    }
    await this.put(state);
    return json({ ok: true, runId });
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
    const team = normalizeConversationTeam(state, payload);
    const roleOverrides = normalizeAgentRolePayload(payload.agentRoles);
    const teamSnapshot = buildConversationTeamSnapshot(state, team, roleOverrides, now);
    const conversation: Conversation = {
      id: `convo-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      kind: "group",
      created_at: now,
      updated_at: now,
      order,
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
	      const base = request.headers.get("X-King-Public-Base") || new URL(request.url).origin;
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
    await this.put(state);
    this.broadcast({ event: "wake", data: { conversationId: message.conversation_id, agentId: targetAgent.id, at: now } });
    const delegated = state.tasks.find((task) => task.requestMessageId === message.id);
    if (delegated?.assignee) {
      await this.broadcast({ event: "wake", data: { agenda: true, conversationId: conversation.id, taskId: delegated.id, agentId: delegated.assignee, at: Date.now() } });
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
	    const base = request.headers.get("X-King-Public-Base") || new URL(request.url).origin;
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
    const publicBase = request.headers.get("X-King-Public-Base") || new URL(request.url).origin;
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
      conversationId: payload.conversationId || "king-convo",
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
    const now = Date.now();
    const task: Task = {
      id: `task-${now}-${Math.random().toString(36).slice(2)}`,
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
      scope: paths.length ? { paths } : undefined,
      created_at: now,
      updated_at: now
    };
    state.tasks.push(task);
    queueTaskAssignmentMessage(state, task, "King");
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
    if (typeof payload.status === "string") {
      if (!isTaskStatus(payload.status)) return json({ error: `invalid task status: ${payload.status}` }, { status: 400 });
      task.status = payload.status;
    }
    if (typeof payload.assignee === "string" && payload.assignee.trim()) task.assignee = payload.assignee.trim();
    if (typeof payload.ownerRole === "string") task.ownerRole = payload.ownerRole.trim() || undefined;
    if (typeof payload.reviewerRole === "string") task.reviewerRole = payload.reviewerRole.trim() || undefined;
    const blockedBy = normalizeStringList(payload.blockedBy);
    if (blockedBy.length) task.blockedBy = blockedBy;
    const acceptance = normalizeStringList(payload.acceptance);
    if (acceptance.length) task.acceptance = acceptance;
    if (typeof payload.result === "string") task.result = payload.result.trim() || undefined;
    applyTaskReviewPayload(task, payload, findAgent(state, task.assignee));
    task.updated_at = Date.now();
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
          queueTaskCompletionMessage(state, task, defaultAgentFor(state).id);
        }
      } else if (task.status === "done") {
        task.assignee = task.coordinatorAgentId ?? defaultAgentFor(state).id;
        queueTaskCompletionMessage(state, task, defaultAgentFor(state).id);
      } else if (task.assignee) {
        queueTaskAssignmentMessage(state, task, "King");
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
    const nextAgent = {
      ...DEFAULT_AGENT,
      ...previous,
      name: name || previous.name || DEFAULT_AGENT.name,
      role: role || previous.role || DEFAULT_AGENT.role,
      engine: engine === "claude" || engine === "codex" ? engine : DEFAULT_AGENT.engine,
      lifecycle,
      model: model || undefined,
      fastModel: fastModel || undefined
    };
    const changed =
      previous.name !== nextAgent.name ||
      previous.role !== nextAgent.role ||
      previous.engine !== nextAgent.engine ||
      previous.lifecycle !== nextAgent.lifecycle ||
      previous.model !== nextAgent.model ||
      previous.fastModel !== nextAgent.fastModel;
    state.agents = normalizeAgents(state.agents).map((agent) => agent.id === nextAgent.id ? nextAgent : agent);
    state.agentConfigUpdatedAt = Date.now();
    if (changed) {
      state.runtimeToken = crypto.randomUUID();
      state.runtimeTokens ??= {};
      delete state.runtimeTokens[nextAgent.id];
    }
    await this.put(state);
    return json({ ok: true, agent: nextAgent });
  }

  private async broadcast(evt: { event: string; data: unknown }): Promise<void> {
    try {
      const state = await this.get();
      state.wakeLog ??= [];
      state.wakeLog.push({ at: Date.now(), event: evt.event, data: evt.data });
      state.wakeLog = state.wakeLog.slice(-WAKE_LOG_CAPACITY);
      await this.put(state);
    } catch {
      // Wake delivery must not depend on observability persistence.
    }
    const frame = encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    await Promise.all([...this.waiters].map(async (writer) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          writer.write(frame),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("sse write timeout")), 1000);
          })
        ]);
      } catch {
        this.waiters.delete(writer);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }));
  }
}

function token(request: Request): string {
  const raw = request.headers.get("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

function tenantHeader(request: Request): string {
  return sanitizeTenantId(request.headers.get("X-King-Tenant") || "global");
}

function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id) return undefined;
  return id === LEGACY_DEFAULT_AGENT_ID ? DEFAULT_AGENT.id : id;
}

function normalizeRuntimeTokens(value: Record<string, string> | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [agentId, tokenValue] of Object.entries(value ?? {})) {
    const id = normalizeAgentId(agentId);
    if (id && typeof tokenValue === "string") next[id] = tokenValue;
  }
  return next;
}

function normalizeRemoteAssistGrant(value: unknown, legacyList?: unknown): RemoteAssistGrant | undefined {
  const source = value && typeof value === "object"
    ? value
    : Array.isArray(legacyList)
      ? legacyList.find((item) => item && typeof item === "object" && !(item as Partial<RemoteAssistGrant>).revokedAt)
      : undefined;
  if (!source || typeof source !== "object") return undefined;
  const row = source as Partial<RemoteAssistGrant>;
  if (typeof row.tokenHash !== "string" || typeof row.createdAt !== "number") return undefined;
  return {
    tokenHash: row.tokenHash,
    tokenPreview: typeof row.tokenPreview === "string" ? row.tokenPreview : "shared",
    createdAt: row.createdAt,
    createdBy: typeof row.createdBy === "string" ? row.createdBy : undefined,
    revokedAt: typeof row.revokedAt === "number" ? row.revokedAt : undefined,
    lastUsedAt: typeof row.lastUsedAt === "number" ? row.lastUsedAt : undefined,
    uses: typeof row.uses === "number" ? row.uses : 0
  };
}

function activeRemoteAssistGrant(state: State): RemoteAssistGrant | undefined {
  state.remoteAssist = normalizeRemoteAssistGrant(state.remoteAssist, (state as State & { remoteAssistGrants?: unknown }).remoteAssistGrants);
  if (!state.remoteAssist || state.remoteAssist.revokedAt) return undefined;
  return state.remoteAssist;
}

function remoteAssistSummary(grant: RemoteAssistGrant): { active: boolean; tokenPreview: string; createdAt: number; revokedAt?: number; uses: number; lastUsedAt?: number } {
  return {
    active: !grant.revokedAt,
    tokenPreview: grant.tokenPreview,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
    uses: grant.uses ?? 0,
    lastUsedAt: grant.lastUsedAt
  };
}

function normalizeMessages(messages: Message[]): Message[] {
  return messages.map(({ body_html: _bodyHtml, ...message }) => ({
    ...message,
    to_agent_id: normalizeAgentId(message.to_agent_id),
    readBy: [...new Set((message.readBy ?? []).map(normalizeAgentId).filter((id): id is string => Boolean(id)))]
  }));
}

const SAFE_MARKDOWN_TAGS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
]);

const SAFE_URI_PATTERN = /^(https?:|mailto:|\/(?!\/)|#)/i;

function sanitizeMarkdownHtml(html: string): string {
  return html
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*style\b[\s\S]*?<\s*\/\s*style\s*>/gi, "")
    .replace(/<\/?([a-zA-Z][\w:-]*)([^>]*)>/g, (tag, rawName: string, rawAttrs: string) => {
      const name = rawName.toLowerCase();
      if (!SAFE_MARKDOWN_TAGS.has(name)) return "";
      if (tag.startsWith("</")) return `</${name}>`;
      const attrs = name === "a" ? sanitizeLinkAttributes(rawAttrs) : "";
      const selfClosing = tag.endsWith("/>") || name === "br" || name === "hr";
      return `<${name}${attrs}${selfClosing ? " />" : ">"}`;
    });
}

function sanitizeLinkAttributes(rawAttrs: string): string {
  const hrefMatch = rawAttrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const href = decodeHtmlAttribute(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "").trim();
  if (!href || !SAFE_URI_PATTERN.test(href)) return "";
  return ` href="${escapeHtmlAttribute(href)}" target="_blank" rel="noreferrer noopener"`;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] ?? ch);
}

async function renderMessageMarkdown(message: Message): Promise<Message> {
  if (message.status === "pending" || message.kind === "system") return { ...message };
  try {
    const rendered = await renderMarkdownHtml(message.body || "");
    return { ...message, body_html: sanitizeMarkdownHtml(rendered) };
  } catch {
    return { ...message };
  }
}

type GuiStateResponse = State | Omit<State, "deviceToken" | "runtimeToken" | "runtimeTokens" | "pairingCode">;

async function stateForGui(state: State, redactSecrets = false): Promise<GuiStateResponse> {
  const visible = {
    ...state,
    messages: await Promise.all(state.messages.map(renderMessageMarkdown))
  };
  if (!redactSecrets) return visible;
  const { deviceToken: _deviceToken, runtimeToken: _runtimeToken, runtimeTokens: _runtimeTokens, pairingCode: _pairingCode, ...redacted } = visible;
  return redacted;
}

function normalizeTasks(tasks: Task[]): Task[] {
  return tasks.map((task) => ({
    ...task,
    assignee: normalizeAgentId(task.assignee),
    coordinatorAgentId: normalizeAgentId(task.coordinatorAgentId),
    reviewerAgentId: normalizeAgentId(task.reviewerAgentId),
    reviewedByAgentId: normalizeAgentId(task.reviewedByAgentId)
  }));
}

function normalizeTaskEvents(events: TaskEvent[]): TaskEvent[] {
  return events.map((event) => ({
    ...event,
    actorAgentId: normalizeAgentId(event.actorAgentId),
    targetAgentId: normalizeAgentId(event.targetAgentId)
  }));
}

function normalizeCards(cards: Card[]): Card[] {
  return cards.map((card) => ({
    ...card,
    assignee: normalizeAgentId(card.assignee),
    claimedBy: normalizeAgentId(card.claimedBy)
  }));
}

function normalizeCalendar(calendar: CalendarItem[]): CalendarItem[] {
  return calendar.map((item) => ({ ...item, assignee: normalizeAgentId(item.assignee) ?? item.assignee }));
}

function normalizeClaims(claims: Claim[]): Claim[] {
  return claims.map((claim) => ({ ...claim, owner: normalizeAgentId(claim.owner) ?? claim.owner }));
}

function normalizeCapsules(capsules: ChangeCapsule[]): ChangeCapsule[] {
  return capsules.map((capsule) => ({ ...capsule, ownerAgent: normalizeAgentId(capsule.ownerAgent) ?? capsule.ownerAgent }));
}

function normalizeMergeQueue(queue: MergeRequest[]): MergeRequest[] {
  return queue.map((entry) => ({ ...entry, agentId: normalizeAgentId(entry.agentId) ?? entry.agentId }));
}

function normalizeArtifacts(artifacts: Artifact[]): Artifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    agentId: normalizeAgentId(artifact.agentId) ?? artifact.agentId,
    source: artifact.source === LEGACY_DEFAULT_AGENT_ID ? DEFAULT_AGENT.id : artifact.source
  }));
}

function normalizeContext(entries: ContextEntry[]): ContextEntry[] {
  return entries.map((entry) => ({ ...entry, updatedBy: normalizeAgentId(entry.updatedBy) ?? entry.updatedBy }));
}

function normalizeHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  return hypotheses.map((hypothesis) => ({ ...hypothesis, agentId: normalizeAgentId(hypothesis.agentId) ?? hypothesis.agentId }));
}

function normalizeReactions(reactions: Reaction[]): Reaction[] {
  return reactions.map((reaction) => ({ ...reaction, authorId: normalizeAgentId(reaction.authorId) ?? reaction.authorId }));
}

function normalizeComposing(claims: ComposingClaim[]): ComposingClaim[] {
  return claims.map((claim) => ({ ...claim, agentId: normalizeAgentId(claim.agentId) ?? claim.agentId }));
}

function normalizeConversations(input: unknown, messages: Message[]): Conversation[] {
  const now = Date.now();
  const byId = new Map<string, Conversation>();
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const row = item as Partial<Conversation>;
      if (typeof row.id !== "string" || !row.id.trim()) continue;
      byId.set(row.id, {
        id: row.id,
        title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : row.id,
        kind: row.kind === "direct" ? "direct" : "group",
        created_at: typeof row.created_at === "number" ? row.created_at : now,
        updated_at: typeof row.updated_at === "number" ? row.updated_at : now,
        order: typeof row.order === "number" ? row.order : undefined,
        teamMode: normalizeTeamMode(row.teamMode),
        coordinatorAgentId: normalizeAgentId(row.coordinatorAgentId) ?? DEFAULT_AGENT.id,
        teamAgentIds: normalizeTeamAgentIds(row.teamAgentIds),
        teamSnapshot: normalizeConversationTeamSnapshot(row.teamSnapshot)
      });
    }
  }
  byId.set(DEFAULT_CONVERSATION.id, {
    ...DEFAULT_CONVERSATION,
    ...byId.get(DEFAULT_CONVERSATION.id),
    title: byId.get(DEFAULT_CONVERSATION.id)?.title || DEFAULT_CONVERSATION.title,
    created_at: byId.get(DEFAULT_CONVERSATION.id)?.created_at || now,
    updated_at: byId.get(DEFAULT_CONVERSATION.id)?.updated_at || now,
    teamMode: normalizeTeamMode(byId.get(DEFAULT_CONVERSATION.id)?.teamMode),
    coordinatorAgentId: normalizeAgentId(byId.get(DEFAULT_CONVERSATION.id)?.coordinatorAgentId) ?? DEFAULT_AGENT.id,
    teamAgentIds: normalizeTeamAgentIds(byId.get(DEFAULT_CONVERSATION.id)?.teamAgentIds),
    teamSnapshot: normalizeConversationTeamSnapshot(byId.get(DEFAULT_CONVERSATION.id)?.teamSnapshot)
  });
  for (const message of messages) {
    const existing = byId.get(message.conversation_id);
    if (existing) {
      existing.updated_at = Math.max(existing.updated_at, message.created_at);
      continue;
    }
    byId.set(message.conversation_id, {
      id: message.conversation_id,
      title: message.conversation_title || message.conversation_id,
      kind: message.conversation_kind || "group",
      created_at: message.created_at,
      updated_at: message.created_at,
      teamMode: "team",
      coordinatorAgentId: DEFAULT_AGENT.id,
      teamAgentIds: normalizeTeamAgentIds(undefined),
      teamSnapshot: undefined
    });
  }
  return [...byId.values()].sort(compareConversations);
}

function ensureConversation(state: State, id: string): Conversation {
  const conversationId = id.trim() || DEFAULT_CONVERSATION.id;
  const found = state.conversations.find((row) => row.id === conversationId);
  if (found) return found;
  const now = Date.now();
  const conversation: Conversation = {
    id: conversationId,
    title: conversationId === DEFAULT_CONVERSATION.id ? DEFAULT_CONVERSATION.title : conversationId,
    kind: "group",
    created_at: now,
    updated_at: now,
    teamMode: "team",
    coordinatorAgentId: DEFAULT_AGENT.id,
    teamAgentIds: normalizeTeamAgentIds(undefined),
    teamSnapshot: undefined
  };
  state.conversations.push(conversation);
  return conversation;
}

function defaultTeamAgents(): Agent[] {
  return DEFAULT_TEAM_AGENTS.map((agent) => ({ ...agent }));
}

function defaultTeamAgentIds(): string[] {
  return DEFAULT_TEAM_AGENTS.map((agent) => agent.id);
}

function normalizeTeamMode(value: unknown): NonNullable<Conversation["teamMode"]> {
  return value === "single" || value === "custom" || value === "team" ? value : "team";
}

function normalizeTeamAgentIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? value.map(normalizeAgentId).filter((id): id is string => Boolean(id)) : [];
  return [...new Set(ids.length ? ids : defaultTeamAgentIds())];
}

function normalizeConversationTeam(state: State, payload: GuiConversationPayload, previous?: Conversation): Required<Pick<Conversation, "teamMode" | "coordinatorAgentId" | "teamAgentIds">> {
  const mode = normalizeTeamMode(payload.teamMode ?? previous?.teamMode);
  const coordinator = defaultAgentFor(state);
  if (mode === "single") {
    return { teamMode: mode, coordinatorAgentId: coordinator.id, teamAgentIds: [coordinator.id] };
  }
  if (mode === "custom") {
    const requestedIds = normalizeStringList(payload.teamAgentIds).map(normalizeAgentId).filter((id): id is string => Boolean(id));
    const ids = [...new Set([coordinator.id, ...requestedIds])].filter((id) => Boolean(findAgent(state, id)));
    return { teamMode: mode, coordinatorAgentId: coordinator.id, teamAgentIds: ids.length ? ids : [coordinator.id] };
  }
  return { teamMode: "team", coordinatorAgentId: DEFAULT_AGENT.id, teamAgentIds: defaultTeamAgentIds() };
}

function normalizeAgentRolePayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const roles = value as Record<string, unknown>;
  const normalized: Record<string, string> = {};
  for (const [agentId, role] of Object.entries(roles)) {
    if (typeof role !== "string") continue;
    const id = normalizeAgentId(agentId);
    if (!id) continue;
    const trimmed = role.trim();
    if (trimmed) normalized[id] = trimmed;
  }
  return normalized;
}

function applyAgentRolePayload(state: State, value: unknown): void {
  const roles = normalizeAgentRolePayload(value);
  let changed = false;
  state.agents = state.agents.map((agent) => {
    const role = roles[agent.id];
    if (!role || role === agent.role) return agent;
    changed = true;
    return { ...agent, role };
  });
  if (changed) state.agentConfigUpdatedAt = Date.now();
}

function normalizeConversationTeamSnapshot(value: unknown): ConversationTeamSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<ConversationTeamSnapshot>;
  const agents = Array.isArray(row.agents)
    ? row.agents.filter((agent): agent is Agent => Boolean(agent) && typeof agent.id === "string" && typeof agent.name === "string" && typeof agent.role === "string")
    : [];
  const teamAgentIds = normalizeTeamAgentIds(row.teamAgentIds);
  const coordinatorAgentId = normalizeAgentId(row.coordinatorAgentId) ?? DEFAULT_AGENT.id;
  if (agents.length === 0) return undefined;
  return {
    mode: normalizeTeamMode(row.mode),
    coordinatorAgentId,
    teamAgentIds,
    agents: agents.map((agent) => ({ ...agent, id: normalizeAgentId(agent.id) ?? agent.id })),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now()
  };
}

function buildConversationTeamSnapshot(
  state: State,
  team: Required<Pick<Conversation, "teamMode" | "coordinatorAgentId" | "teamAgentIds">>,
  roleOverrides: Record<string, string> = {},
  createdAt = Date.now()
): ConversationTeamSnapshot {
  const agents = team.teamAgentIds.map((id) => {
    const agent = findAgent(state, id) ?? DEFAULT_TEAM_AGENTS.find((row) => row.id === id) ?? defaultAgentFor(state);
    return {
      ...agent,
      role: roleOverrides[id] || agent.role
    };
  });
  return {
    mode: team.teamMode,
    coordinatorAgentId: team.coordinatorAgentId,
    teamAgentIds: team.teamAgentIds,
    agents,
    createdAt
  };
}

function normalizeAgents(agents: Agent[] | undefined): Agent[] {
  const byId = new Map<string, Agent>();
  const incoming = Array.isArray(agents) && agents.length ? agents : [DEFAULT_AGENT];
  for (const agent of incoming) {
    if (!agent?.id) continue;
    const id = normalizeAgentId(agent.id);
    if (!id) continue;
    byId.set(id, { ...agent, id });
  }
  for (const agent of DEFAULT_TEAM_AGENTS) {
    const existing = byId.get(agent.id);
    const normalized = { ...agent, ...existing };
    if (agent.id === DEFAULT_AGENT.id) {
      if (!existing?.name || existing.name === LEGACY_DEFAULT_AGENT_NAME) normalized.name = agent.name;
      if (!existing?.role || existing.role === LEGACY_DEFAULT_AGENT_ROLE) normalized.role = agent.role;
    } else if (agent.id === "dev" && (!existing?.role || existing.role === LEGACY_DEFAULT_DEV_ROLE)) {
      normalized.role = agent.role;
    } else if (agent.id === "reviewer" && (!existing?.role || existing.role === LEGACY_DEFAULT_REVIEWER_ROLE)) {
      normalized.role = agent.role;
    }
    byId.set(agent.id, normalized);
  }
  return [...byId.values()];
}

function findAgent(state: State, agentId?: string | null): Agent | undefined {
  const id = normalizeAgentId(agentId);
  if (!id) return undefined;
  return state.agents.find((agent) => agent.id === id);
}

function defaultAgentFor(state: State): Agent {
  return findAgent(state, DEFAULT_AGENT.id) ?? state.agents[0] ?? DEFAULT_AGENT;
}

function coordinatorAgentFor(state: State, conversation: Conversation): Agent {
  const snapshot = conversation.teamSnapshot;
  if (snapshot) {
    const agent = snapshot.agents.find((row) => row.id === snapshot.coordinatorAgentId);
    if (agent) return agent;
  }
  return findAgent(state, conversation.coordinatorAgentId) ?? defaultAgentFor(state);
}

function teamAgentsFor(state: State, conversation?: Conversation): Agent[] {
  if (conversation?.teamSnapshot?.agents.length) return conversation.teamSnapshot.agents.map((agent) => ({ ...agent }));
  const ids = normalizeTeamAgentIds(conversation?.teamAgentIds);
  const rows = ids.map((id) => findAgent(state, id)).filter((agent): agent is Agent => Boolean(agent));
  return rows.length ? rows : [defaultAgentFor(state)];
}

function teamSpecForConversation(state: State, conversation: Conversation) {
  const base = defaultTeamSpec(`${conversation.id}-team`, conversation.title || "GUI Conversation Team");
  const agents = teamAgentsFor(state, conversation);
  return {
    ...base,
    roles: agents.map((agent) => {
      const template = roleTemplateForAgent(agent);
      const baseRole = base.roles.find((role) => role.template === template);
      return {
        id: agent.id,
        template,
        responsibility: agent.role,
        capabilities: baseRole?.capabilities ?? [],
        handoffPolicy: baseRole?.handoffPolicy ?? {
          mode: "one-of-us" as const,
          escalation: "coordinator" as const,
          acceptanceRequired: false
        }
      };
    })
  };
}

function defaultWorkerAgentFor(state: State): Agent {
  return findAgent(state, "dev") ?? defaultAgentFor(state);
}

function reviewerAgentFor(state: State): Agent {
  return findAgent(state, "reviewer") ?? defaultAgentFor(state);
}

function agentForRoleInConversation(state: State, conversation: Conversation, role: string): Agent | undefined {
  return teamAgentsFor(state, conversation).find((agent) => agent.id === role || roleTemplateForAgent(agent) === role);
}

function workerAgentForConversation(state: State, conversation: Conversation): Agent | undefined {
  const ids = new Set(teamAgentsFor(state, conversation).map((agent) => agent.id));
  return ids.has("dev") ? teamAgentsFor(state, conversation).find((agent) => agent.id === "dev") : undefined;
}

function reviewerAgentForConversation(state: State, conversation: Conversation): Agent | undefined {
  const ids = new Set(teamAgentsFor(state, conversation).map((agent) => agent.id));
  return ids.has("reviewer") ? teamAgentsFor(state, conversation).find((agent) => agent.id === "reviewer") : undefined;
}

function agentIdForRuntimeToken(state: State, runtimeToken: string): string | null {
  if (!runtimeToken) return null;
  for (const [agentId, tokenValue] of Object.entries(state.runtimeTokens ?? {})) {
    if (tokenValue === runtimeToken) return agentId;
  }
  return runtimeToken === state.runtimeToken ? DEFAULT_AGENT.id : null;
}

function autoDelegateMessage(state: State, conversation: Conversation, message: Message, coordinator: Agent): Task | undefined {
  const ownerRole = selectOwnerRole(teamSpecForConversation(state, conversation), requiredCapabilitiesForText(message.body)) ?? "builder";
  const worker = agentForRoleInConversation(state, conversation, ownerRole) ?? workerAgentForConversation(state, conversation);
  if (!worker) return undefined;
  const reviewer = agentForRoleInConversation(state, conversation, "reviewer") ?? reviewerAgentForConversation(state, conversation);
  const now = Date.now();
  const task: Task = {
    id: `task-${now}-${Math.random().toString(36).slice(2)}`,
    title: message.body.slice(0, 80) || `Handle ${conversation.title}`,
    description: `Handle the human request in ${conversation.title}: ${message.body}`,
    status: "assigned",
    assignee: worker.id,
    ownerRole,
    reviewerRole: reviewer ? "reviewer" : undefined,
    priority: message.priority === "steer" ? 8 : 5,
    acceptance: [
      "The assigned agent reports concrete output or files changed.",
      reviewer ? "Reviewer approves or requests specific revisions before Planner summarizes." : "Planner receives a concrete completion summary."
    ],
    conversationId: conversation.id,
    requestMessageId: message.id,
    coordinatorAgentId: coordinator.id,
    reviewerAgentId: reviewer?.id,
    created_at: now,
    updated_at: now
  };
  state.tasks.push(task);
  queueTaskAssignmentMessage(state, task, coordinator.id);
  pushLoopEvent(state, {
    type: "queue.backlog",
    agent: worker.id,
    taskId: task.id,
    pendingMessages: unreadMessagesFor(state, worker.id).length,
    payload: { taskId: task.id, source: "gui-message", conversationId: conversation.id, requestMessageId: message.id }
  });
  return task;
}

function advanceTaskDone(state: State, task: Task, actor: Agent, resultText?: string): string {
  const previousStatus = task.status;
  if (resultText?.trim()) task.result = resultText.trim();
  if (!task.reviewerAgentId && !task.conversationId) {
    task.status = "done";
    task.updated_at = Date.now();
    if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
    return `Task ${task.id} marked done.`;
  }
  if (!task.reviewerAgentId) {
    task.status = "done";
    task.assignee = task.coordinatorAgentId ?? DEFAULT_AGENT.id;
    task.updated_at = Date.now();
    if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
    queueTaskCompletionMessage(state, task, actor.name);
    return `Task ${task.id} marked done and returned to ${task.assignee}.`;
  }
  if (actor.id === task.reviewerAgentId || task.status === "review") {
    task.status = "done";
    task.assignee = task.coordinatorAgentId ?? DEFAULT_AGENT.id;
    task.reviewResult = "approved";
    task.reviewedByAgentId = actor.id;
    task.reviewedAt = Date.now();
    task.updated_at = Date.now();
    if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
    queueTaskCompletionMessage(state, task, actor.name);
    return `Task ${task.id} marked done and returned to ${task.assignee}.`;
  }
  const reviewer = findAgent(state, task.reviewerAgentId) ?? reviewerAgentFor(state);
  task.status = "review";
  task.assignee = reviewer.id;
  task.reviewerAgentId = reviewer.id;
  task.updated_at = Date.now();
  if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
  queueTaskReviewMessage(state, task, actor.id);
  return `Task ${task.id} submitted for review by ${reviewer.id}.`;
}

function pushTaskTransition(state: State, task: Task, previousStatus: TaskStatus): void {
  pushLoopEvent(state, {
    type: "task.transition",
    agent: task.assignee,
    taskId: task.id,
    from: previousStatus,
    to: task.status
  });
}

function applyTaskReviewPayload(task: Task, payload: GuiTaskUpdatePayload, reviewer?: Agent): void {
  if (payload.reviewResult === "approved" || payload.reviewResult === "changes_requested") {
    task.reviewResult = payload.reviewResult;
    task.reviewedByAgentId = reviewer?.id ?? task.reviewedByAgentId;
    task.reviewedAt = Date.now();
  }
  if (typeof payload.revisionReason === "string") task.revisionReason = payload.revisionReason.trim() || undefined;
  const artifactIds = normalizeStringList(payload.artifactIds);
  if (artifactIds.length) task.artifactIds = artifactIds;
}

function recordTaskEvent(
  state: State,
  task: Task,
  args: Omit<TaskEvent, "id" | "taskId" | "conversationId" | "created_at">
): TaskEvent {
  const event: TaskEvent = {
    id: `task-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    taskId: task.id,
    conversationId: task.conversationId,
    created_at: Date.now(),
    ...args
  };
  state.taskEvents.push(event);
  return event;
}

function taskEventPayload(event: TaskEvent, task: Task): Record<string, unknown> {
  return {
    taskEventId: event.id,
    taskEventType: event.type,
    taskId: task.id,
    title: task.title,
    description: task.description,
    result: task.result,
    reviewResult: task.reviewResult,
    revisionReason: task.revisionReason,
    artifactIds: task.artifactIds ?? []
  };
}

function queueTaskAssignmentMessage(state: State, task: Task, fromName: string): void {
  if (!task.assignee) return;
  const target = findAgent(state, task.assignee);
  if (!target) return;
  const now = Date.now();
  const conversation = ensureConversation(state, task.conversationId || DEFAULT_CONVERSATION.id);
  const event = recordTaskEvent(state, task, {
    type: "assigned",
    actorAgentId: task.coordinatorAgentId,
    targetAgentId: target.id,
    summary: `Assigned to ${target.name || target.id}`
  });
  state.messages.push({
    id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title,
    conversation_kind: conversation.kind,
    author_name: fromName,
    author_kind: "system",
    kind: "message",
    body: `Task assigned to ${target.id}: ${task.id} "${task.title}"${task.description ? ` - ${task.description}` : ""}`,
    priority: "steer",
    message_type: "message",
    to_agent_id: target.id,
    payload: taskEventPayload(event, task),
    created_at: now,
    readBy: []
  });
  conversation.updated_at = now;
}

function queueTaskReviewMessage(state: State, task: Task, fromAgentId: string): void {
  if (!task.assignee) return;
  const target = findAgent(state, task.assignee);
  if (!target) return;
  const now = Date.now();
  const conversation = ensureConversation(state, task.conversationId || DEFAULT_CONVERSATION.id);
  const event = recordTaskEvent(state, task, {
    type: "submitted_for_review",
    actorAgentId: fromAgentId,
    targetAgentId: target.id,
    summary: `Submitted for review by ${fromAgentId}`,
    result: task.result
  });
  state.messages.push({
    id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title,
    conversation_kind: conversation.kind,
    author_name: fromAgentId,
    author_kind: "system",
    kind: "message",
    body: `Task assigned to ${target.id}: ${task.id} "${task.title}"${task.result ? ` - Review result: ${task.result}` : ""}`,
    priority: "steer",
    message_type: "message",
    to_agent_id: target.id,
    payload: taskEventPayload(event, task),
    created_at: now,
    readBy: []
  });
  conversation.updated_at = now;
}

function queueTaskChangesRequestedMessage(state: State, task: Task, targetAgentId: string): void {
  const target = findAgent(state, targetAgentId);
  if (!target) return;
  const now = Date.now();
  const conversation = ensureConversation(state, task.conversationId || DEFAULT_CONVERSATION.id);
  const event = recordTaskEvent(state, task, {
    type: "changes_requested",
    actorAgentId: task.reviewedByAgentId ?? task.reviewerAgentId,
    targetAgentId,
    summary: task.revisionReason || "Reviewer requested revisions",
    reviewResult: "changes_requested",
    revisionReason: task.revisionReason,
    artifactIds: task.artifactIds
  });
  state.messages.push({
    id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title,
    conversation_kind: conversation.kind,
    author_name: "Reviewer",
    author_kind: "system",
    kind: "message",
    body: `Task revisions requested for ${target.id}: ${task.id} "${task.title}"${task.revisionReason ? ` - ${task.revisionReason}` : ""}`,
    priority: "steer",
    message_type: "blocker",
    to_agent_id: target.id,
    payload: taskEventPayload(event, task),
    created_at: now,
    readBy: []
  });
  conversation.updated_at = now;
}

function queueTaskCompletionMessage(state: State, task: Task, fromName = "Reviewer"): void {
  const ceo = findAgent(state, task.coordinatorAgentId) ?? defaultAgentFor(state);
  const now = Date.now();
  const conversation = ensureConversation(state, task.conversationId || DEFAULT_CONVERSATION.id);
  const event = recordTaskEvent(state, task, {
    type: "completed",
    actorAgentId: task.reviewedByAgentId ?? task.reviewerAgentId ?? task.assignee,
    targetAgentId: ceo.id,
    summary: task.result || `Completed by ${fromName}`,
    result: task.result,
    reviewResult: task.reviewResult,
    artifactIds: task.artifactIds
  });
  state.messages.push({
    id: `msg-${now}-${Math.random().toString(36).slice(2)}`,
    conversation_id: conversation.id,
    conversation_title: conversation.title,
    conversation_kind: conversation.kind,
    author_name: fromName,
    author_kind: "system",
    kind: "message",
    body: `Task completed: ${task.id} "${task.title}"${task.result ? ` - ${task.result}` : ""}. Summarize the result for the human in #${conversation.title}.`,
    priority: "steer",
    message_type: "decision",
    to_agent_id: ceo.id,
    payload: taskEventPayload(event, task),
    created_at: now,
    readBy: []
  });
  conversation.updated_at = now;
}

function conversationSummaries(state: State): Array<Conversation & { unread: number; messages: number }> {
  return state.conversations.slice().sort(compareConversations).map((conversation) => {
    const rows = state.messages.filter((message) => message.conversation_id === conversation.id && isRuntimeVisibleMessage(message));
    return {
      ...conversation,
      unread: rows.filter((message) => !message.readBy.includes(DEFAULT_AGENT.id) && message.author_kind === "human").length,
      messages: rows.length
    };
  });
}

function isRuntimeVisibleMessage(message: Message): boolean {
  return message.status !== "pending";
}

function unreadMessagesFor(state: State, agentId: string): Message[] {
  return state.messages.filter((message) =>
    isRuntimeVisibleMessage(message) &&
    (!message.to_agent_id || message.to_agent_id === agentId) &&
    !message.readBy.includes(agentId)
  );
}

function compareConversations(a: Conversation, b: Conversation): number {
  if (a.id === DEFAULT_CONVERSATION.id) return -1;
  if (b.id === DEFAULT_CONVERSATION.id) return 1;
  return (b.order ?? b.created_at) - (a.order ?? a.created_at)
    || b.updated_at - a.updated_at
    || b.created_at - a.created_at
    || b.id.localeCompare(a.id);
}

function normalizeCapabilities(input: unknown): { workspaces: string[]; agentWorkspaceRoot?: string } {
  if (!input || typeof input !== "object") return { workspaces: [] };
  const raw = (input as { workspaces?: unknown }).workspaces;
  const workspaces = Array.isArray(raw)
    ? raw.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map((path) => path.trim())
    : [];
  const agentWorkspaceRoot = (input as { agentWorkspaceRoot?: unknown }).agentWorkspaceRoot;
  return {
    workspaces,
    agentWorkspaceRoot: typeof agentWorkspaceRoot === "string" && agentWorkspaceRoot.trim() ? agentWorkspaceRoot.trim() : undefined
  };
}

function normalizeStringList(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, idx, all) => all.indexOf(item) === idx);
}

function runtimeBodyStatus(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const status = (body as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}

function runtimeBodyEngine(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const trigger = (body as { trigger?: unknown }).trigger;
  if (!trigger || typeof trigger !== "object") return undefined;
  const engine = (trigger as { engine?: unknown }).engine;
  return typeof engine === "string" ? engine : undefined;
}

function normalizeRunStreamEvent(value: unknown): RunStreamEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { stream?: unknown; event?: unknown; type?: unknown; text?: unknown; name?: unknown; id?: unknown; input?: unknown; output?: unknown; error?: unknown; message?: unknown };
  const event = row.stream && typeof row.stream === "object"
    ? row.stream as typeof row
    : row.event && typeof row.event === "object"
      ? row.event as typeof row
      : row;
  if (event.type === "reasoning_delta" && typeof event.text === "string") return { type: "reasoning_delta", text: event.text };
  if (event.type === "message_delta" && typeof event.text === "string") return { type: "message_delta", text: event.text };
  if (event.type === "tool_started" && typeof event.name === "string") {
    return {
      type: "tool_started",
      id: typeof event.id === "string" ? event.id : undefined,
      name: event.name,
      input: typeof event.input === "string" ? event.input : undefined
    };
  }
  if (event.type === "tool_delta" && typeof event.text === "string") {
    return {
      type: "tool_delta",
      id: typeof event.id === "string" ? event.id : undefined,
      text: event.text
    };
  }
  if (event.type === "tool_done") {
    return {
      type: "tool_done",
      id: typeof event.id === "string" ? event.id : undefined,
      output: typeof event.output === "string" ? event.output : undefined,
      error: typeof event.error === "string" ? event.error : undefined
    };
  }
  if (event.type === "done") return { type: "done" };
  if (event.type === "interrupted") return { type: "interrupted" };
  if (event.type === "error") return { type: "error", message: typeof event.message === "string" ? event.message : "run failed" };
  return null;
}

function approximateBase64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function uploadChunkKey(id: string, index: number): string {
  return `upload:${id}:chunk:${index}`;
}

function pruneUploads(uploads: Record<string, UploadedAttachment>): Record<string, UploadedAttachment> {
  return Object.fromEntries(
    Object.entries(uploads)
      .sort(([, a], [, b]) => b.createdAt - a.createdAt)
      .slice(0, GUI_ATTACHMENT_STORE_CAPACITY)
  );
}

function normalizeEngineId(value: unknown): Agent["engine"] | undefined {
  return value === "claude" || value === "codex" ? value : undefined;
}

function activeRunEngine(state: State): Agent["engine"] | undefined {
  const lastRunStart = state.runLog.slice().reverse().find((row) => row.action === "start");
  const lastRunFinish = state.runLog.slice().reverse().find((row) => row.action === "finish");
  if (!lastRunStart || (lastRunFinish && lastRunFinish.at >= lastRunStart.at)) return undefined;
  return normalizeEngineId(runtimeBodyEngine(lastRunStart?.body));
}

function summarizeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return String(value ?? "");
  const record = value as Record<string, unknown>;
  for (const key of ["message", "status", "reason", "error", "type"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return JSON.stringify(value).slice(0, 180);
}

function agentStateSummary(state: State, agent: Agent): AgentStateSummary {
  const lifecycle = agent.lifecycle ?? "on-demand";
  const latestStatus = state.statusLog.slice().reverse().find((row) => !row.agentId || row.agentId === agent.id);
  const status = lifecycle === "disabled" ? "disabled" : latestStatus?.status ?? "idle";
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    engine: agent.engine ?? "auto",
    lifecycle,
    status,
    model: agent.model ?? "default",
    fastModel: agent.fastModel ?? "default",
    unreadMessages: unreadMessagesFor(state, agent.id).length,
    openClaims: state.claims.filter((claim) => claim.owner === agent.id).length,
    activeCards: state.cards.filter((card) => card.column !== "done" && (card.assignee === agent.id || card.claimedBy === agent.id)).length,
    openTasks: state.tasks.filter((task) => task.status !== "done" && (!task.assignee || task.assignee === agent.id)).length,
    blockedTasks: state.tasks.filter((task) => taskVisibleStatus(state, task) === "blocked" && (!task.assignee || task.assignee === agent.id)).length,
    lastStatusAt: latestStatus?.at
  };
}

function formatRosterAgent(agent: AgentStateSummary): string {
  return [
    agent.id,
    agent.name,
    agent.role,
    `engine=${agent.engine}`,
    `lifecycle=${agent.lifecycle}`,
    `status=${agent.status}`,
    `model=${agent.model}`,
    `fastModel=${agent.fastModel}`,
    `unread=${agent.unreadMessages}`,
    `claims=${agent.openClaims}`,
    `cards=${agent.activeCards}`,
    `tasks=${agent.openTasks}`,
    `blocked=${agent.blockedTasks}`
  ].join("\t");
}

function buildRuntimePreamble(
  state: State,
  options: { agentId: string; reason: string; runId?: string; steerReason?: string }
): string {
  const agent = state.agents.find((row) => row.id === options.agentId) ?? state.agents[0] ?? DEFAULT_AGENT;
  const lines: string[] = [
    `## Runtime Context (Loop #${state.currentLoop})`,
    `Agent: ${agent.id} (${agent.name})`,
    `Role: ${agent.role}`,
    `Reason: ${options.reason}`,
    `Run ID: ${options.runId || state.loopRunId || "run-gui"}`
  ];
  if (options.steerReason) {
    lines.push("");
    lines.push(`Steer interrupt: ${options.steerReason.slice(0, 300)}`);
    lines.push("Prioritize the steer before resuming previous work.");
  }
  const tasks = state.tasks
    .filter((task) =>
      task.assignee === agent.id ||
      task.status === "pending" ||
      task.status === "assigned"
    )
    .slice(0, 10);
  if (tasks.length > 0) {
    lines.push("");
    lines.push("### Current Tasks");
    for (const task of tasks) {
      lines.push(`- [${taskVisibleStatus(state, task)}] ${task.id.slice(0, 12)} ${task.title}${task.assignee ? ` (${task.assignee})` : ""}`);
    }
    const total = state.tasks.filter((task) =>
      task.assignee === agent.id ||
      task.status === "pending" ||
      task.status === "assigned"
    ).length;
    if (total > tasks.length) lines.push(`- ...and ${total - tasks.length} more task(s)`);
  }
  const unread = unreadMessagesFor(state, agent.id)
    .slice(-5);
  if (unread.length > 0) {
    lines.push("");
    lines.push("### Recent Unread Messages");
    for (const message of unread) {
      const priority = message.priority === "steer" ? " [STEER]" : "";
      lines.push(`- ${message.author_name}${priority}: ${(message.body || "").replace(/\s+/g, " ").slice(0, 120)}`);
      const attachments = formatAttachmentPrompt(message.attachments ?? []);
      if (attachments) {
        for (const line of attachments.split("\n")) lines.push(`  ${line}`);
      }
    }
  }
  if (state.context.length > 0) {
    lines.push("");
    lines.push("### Shared Context");
    for (const entry of state.context.slice(-5)) {
      lines.push(`- ${entry.key}: ${entry.value.slice(0, 160)}`);
    }
  }
  const loopEvents = state.loopEvents
    .filter((event) => event.runId === state.loopRunId || event.loop === state.currentLoop)
    .slice(-5);
  if (loopEvents.length > 0) {
    lines.push("");
    lines.push("### Recent Loop Events");
    for (const event of loopEvents) lines.push(`- ${formatLoopEventLine(event)}`);
  }
  return lines.join("\n");
}

function formatEventRouteLine(route: EventRoute): string {
  return `${route.eventType}\t-> ${route.agentId}`;
}

function parseExternalEventArgs(eventType: string, args: string[]): ExternalEvent {
  return {
    type: eventType,
    source: readOption(args, "--source") || "cli",
    payload: parseEventPayload(args),
    timestamp: Date.now()
  };
}

function parseEventPayload(args: string[]): unknown {
  const raw = firstJsonArg(args);
  if (!raw) return {};
  try {
    return JSON.parse(stripJsonFence(raw));
  } catch {
    return { text: raw };
  }
}

function normalizeExternalEvent(body: unknown): ExternalEvent | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  if (typeof rec.type !== "string" || !rec.type.trim()) return null;
  return {
    type: rec.type.trim(),
    source: typeof rec.source === "string" && rec.source.trim() ? rec.source.trim() : "runtime",
    payload: "payload" in rec ? rec.payload : {},
    timestamp: typeof rec.timestamp === "number" ? rec.timestamp : Date.now()
  };
}

function routeExternalEvent(state: State, event: ExternalEvent): string[] {
  const subscribers = new Set<string>();
  for (const route of state.eventRoutes) {
    if (route.eventType === event.type) subscribers.add(route.agentId);
  }
  for (const agent of state.agents) {
    if ((agent.events ?? []).includes(event.type)) subscribers.add(agent.id);
  }
  for (const agentId of subscribers) {
    state.messages.push(eventMessage(event, agentId));
  }
  return [...subscribers].sort();
}

function eventMessage(event: ExternalEvent, agentId: string): Message {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    conversation_id: `event-${event.type}-${agentId}`,
    conversation_title: `Event ${event.type}`,
    conversation_kind: "direct",
    author_name: "Runtime Event",
    author_kind: "system",
    kind: "message",
    body: `Event ${event.type} from ${event.source}: ${JSON.stringify(event.payload)}`,
    priority: "normal",
    message_type: "message",
    to_agent_id: agentId,
    payload: event,
    created_at: event.timestamp,
    readBy: []
  };
}

function formatAgentMatrixLine(agent: AgentStateSummary): string {
  const marker = agent.status === "running" || agent.status === "thinking" ? "*" : agent.status === "idle" ? "-" : "x";
  const model = agent.model === "default" ? agent.engine : agent.model;
  return [
    `  ${marker}`,
    agent.id.padEnd(15),
    agent.status.padEnd(10),
    agent.lifecycle.padEnd(10),
    model,
    `unread=${agent.unreadMessages}`,
    `tasks=${agent.openTasks}`
  ].join(" ");
}

function pushLoopEvent(
  state: State,
  event: Omit<LoopEvent, "runId" | "loop" | "timestamp"> & Partial<Pick<LoopEvent, "runId" | "loop" | "timestamp">>
): LoopEvent {
  const full: LoopEvent = {
    ...event,
    runId: event.runId || state.loopRunId || "run-gui",
    loop: event.loop ?? state.currentLoop,
    timestamp: event.timestamp || new Date().toISOString()
  };
  state.loopEvents.push(full);
  if (state.loopEvents.length > LOOP_EVENT_BUFFER_CAPACITY) {
    state.loopEvents = state.loopEvents.slice(-LOOP_EVENT_BUFFER_CAPACITY);
  }
  return full;
}

function isLoopEventType(value: string | undefined): value is LoopEventType {
  return value === "loop.tick" ||
    value === "loop.classified" ||
    value === "agent.spawned" ||
    value === "task.transition" ||
    value === "task.blocked" ||
    value === "queue.backlog" ||
    value === "artifact.created" ||
    value === "agent.budget_exceeded";
}

function buildEventLoopSnapshot(state: State): LoopSnapshot {
  const runId = state.loopRunId || "run-gui";
  const loop = state.currentLoop;
  const currentEvents = state.loopEvents.filter((event) => event.runId === runId && event.loop === loop);
  const reasons: string[] = [];
  let classification: LoopClassification = "idle";
  const budgetExceeded = currentEvents.filter((event) => event.type === "agent.budget_exceeded").length;
  const productive = currentEvents.filter((event) => event.type === "task.transition" || event.type === "artifact.created").length;
  const backlog = currentEvents.filter((event) => event.type === "queue.backlog" && (event.pendingMessages ?? 1) > 0).length;
  const blocked = currentEvents.filter((event) => event.type === "task.blocked").length;
  if (budgetExceeded > 0) {
    classification = "error";
    reasons.push(`${budgetExceeded} budget exceeded event(s)`);
  } else if (productive > 0) {
    classification = "productive";
    reasons.push(`${productive} productive event(s)`);
  } else if (backlog > 0) {
    classification = "backlog_stuck";
    reasons.push(`${backlog} backlog event(s) pending`);
  } else if (blocked > 0) {
    classification = "blocked";
    reasons.push(`${blocked} blocked task event(s)`);
  } else {
    reasons.push("no loop events detected");
  }
  const inferred = buildLoopSnapshot(state);
  return {
    ...inferred,
    runId,
    loop,
    classification,
    reasons,
    recentEvents: currentEvents.slice(-20)
  };
}

function countPendingMessages(state: State, agentId: string): number {
  return state.messages.filter((message) =>
    isRuntimeVisibleMessage(message) &&
    message.to_agent_id === agentId &&
    !message.readBy.includes(agentId)
  ).length;
}

function formatLoopEventLine(event: LoopEvent): string {
  const agent = event.agent ? ` agent=${event.agent}` : "";
  const task = event.taskId ? ` task=${event.taskId.slice(0, 12)}` : "";
  const transition = event.from || event.to ? ` ${event.from ?? "?"}->${event.to ?? "?"}` : "";
  const backlog = event.pendingMessages !== undefined ? ` pending=${event.pendingMessages}` : "";
  const artifact = event.kind || event.path ? ` ${[event.kind, event.path].filter(Boolean).join(" ")}` : "";
  const classification = event.classification ? ` classification=${event.classification}` : "";
  return `[${event.loop}] ${event.type}${agent}${task}${transition}${backlog}${artifact}${classification}`;
}

function buildLoopSnapshot(state: State): LoopSnapshot {
  const unreadMessages = unreadMessagesFor(state, DEFAULT_AGENT.id).length;
  const blockedTasks = state.tasks.filter((task) => taskVisibleStatus(state, task) === "blocked").length;
  const activeTasks = state.tasks.filter((task) => taskVisibleStatus(state, task) !== "done").length;
  const openCapsules = state.capsules.filter((capsule) => capsule.status === "open").length;
  const inReviewCapsules = state.capsules.filter((capsule) => capsule.status === "in_review").length;
  const failedRuns = state.runLog.filter((row) =>
    row.action === "finish" &&
    row.body &&
    typeof row.body === "object" &&
    (row.body as { status?: unknown }).status === "failed"
  ).length;
  const reasons: string[] = [];
  let classification: LoopClassification = "idle";
  if (failedRuns > 0) {
    classification = "error";
    reasons.push(`${failedRuns} failed run(s)`);
  } else if (state.artifacts.length > 0 || inReviewCapsules > 0 || state.tasks.some((task) => task.status === "done" || task.status === "review")) {
    classification = "productive";
    if (state.artifacts.length > 0) reasons.push(`${state.artifacts.length} artifact(s) recorded`);
    if (inReviewCapsules > 0) reasons.push(`${inReviewCapsules} capsule(s) in review`);
    const advancedTasks = state.tasks.filter((task) => task.status === "done" || task.status === "review").length;
    if (advancedTasks > 0) reasons.push(`${advancedTasks} task(s) advanced`);
  } else if (unreadMessages > 0) {
    classification = "backlog_stuck";
    reasons.push(`${unreadMessages} unread message(s) pending`);
  } else if (blockedTasks > 0) {
    classification = "blocked";
    reasons.push(`${blockedTasks} task(s) blocked by dependencies`);
  } else {
    reasons.push("no state changes detected");
  }
  return {
    classification,
    reasons,
    counts: {
      unreadMessages,
      blockedTasks,
      activeTasks,
      openCapsules,
      inReviewCapsules,
      artifacts: state.artifacts.length,
      failedRuns
    }
  };
}

function isTaskStatus(value: string): value is TaskStatus {
  return value === "pending" || value === "assigned" || value === "in_progress" || value === "review" || value === "done" || value === "failed";
}

function isInitiativeStatus(value: string): value is InitiativeStatus {
  return value === "active" || value === "paused" || value === "completed" || value === "abandoned";
}

function isCapsuleStatus(value: string): value is CapsuleStatus {
  return value === "open" || value === "in_review" || value === "merged" || value === "abandoned";
}

function isCapsuleScopeType(value: string): value is CapsuleScopeType {
  return value === "code" || value === "docs" || value === "tests" || value === "ops" || value === "mixed";
}

function normalizePriority(value: string | undefined): number {
  const parsed = Number.parseInt(value || "5", 10);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(10, Math.max(1, parsed));
}

function parseCsvOption(args: string[], name: string): string[] | undefined {
  const raw = readOption(args, name);
  if (!raw) return undefined;
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

function taskScopeFromArgs(args: string[]): Task["scope"] | undefined {
  const paths = parseCsvOption(args, "--path");
  const patterns = parseCsvOption(args, "--pattern");
  if (!paths && !patterns) return undefined;
  return { paths, patterns };
}

type TaskLookupResult = {
  task?: Task;
  error: string;
  ambiguous: boolean;
};

function lookupTask(state: State, id: string | undefined): TaskLookupResult {
  if (!id) return { error: "task id required", ambiguous: false };
  const exact = state.tasks.find((task) => task.id === id);
  if (exact) return { task: exact, error: "", ambiguous: false };
  const matches = state.tasks.filter((task) => task.id.startsWith(id));
  if (matches.length === 1) return { task: matches[0], error: "", ambiguous: false };
  if (matches.length > 1) {
    const options = matches.slice(0, 8).map((task) => task.id).join(", ");
    const suffix = matches.length > 8 ? `, ... ${matches.length - 8} more` : "";
    return { error: `ambiguous task id: ${id}; matches: ${options}${suffix}`, ambiguous: true };
  }
  return { error: `task not found: ${id}`, ambiguous: false };
}

function findTask(state: State, id: string | undefined): Task | undefined {
  return lookupTask(state, id).task;
}

function pendingBelongsToAgent(message: Message, agent: Agent): boolean {
  if (message.to_agent_id) return message.to_agent_id === agent.id;
  return message.author_name === agent.name;
}

function taskIdsMatch(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function taskVisibleStatus(state: State, task: Task): TaskStatus | "blocked" {
  if (task.status === "done") return "done";
  const doneIds = state.tasks.filter((row) => row.status === "done").map((row) => row.id);
  const blocked = (task.dependsOn ?? []).some((id) => !doneIds.some((doneId) => taskIdsMatch(doneId, id)));
  return blocked ? "blocked" : task.status;
}

function formatTaskLine(state: State, task: Task): string {
  const assignee = task.assignee ? ` -> ${task.assignee}` : "";
  const dependsOn = task.dependsOn?.length ? ` (after: ${task.dependsOn.map((id) => id.slice(0, 8)).join(",")})` : "";
  const scope = task.scope?.paths?.length ? ` paths=${task.scope.paths.join(",")}` : "";
  const refs = [
    task.initiativeId ? `I:${task.initiativeId.slice(0, 8)}` : "",
    task.capsuleId ? `C:${task.capsuleId.slice(0, 8)}` : "",
    task.subsystem ? `subsystem=${task.subsystem}` : ""
  ].filter(Boolean).join(" ");
  return `[${taskVisibleStatus(state, task)}] ${task.id.slice(0, 12)} P${task.priority} "${task.title}"${assignee}${dependsOn}${scope}${refs ? ` [${refs}]` : ""}`;
}

function findInitiative(state: State, id: string | undefined): Initiative | undefined {
  if (!id) return undefined;
  return state.initiatives.find((initiative) => initiative.id === id || initiative.id.startsWith(id));
}

function formatInitiativeLine(state: State, initiative: Initiative): string {
  const taskCount = state.tasks.filter((task) => task.initiativeId === initiative.id).length;
  const capsuleCount = state.capsules.filter((capsule) => capsule.initiativeId === initiative.id).length;
  const summary = initiative.summary ? ` - ${initiative.summary.slice(0, 100)}` : "";
  return `[${initiative.status}] ${initiative.id.slice(0, 14)} P${initiative.priority} "${initiative.title}"${summary} tasks=${taskCount} capsules=${capsuleCount}`;
}

function findCapsule(state: State, id: string | undefined): ChangeCapsule | undefined {
  if (!id) return undefined;
  return state.capsules.find((capsule) => capsule.id === id || capsule.id.startsWith(id));
}

function formatCapsuleLine(capsule: ChangeCapsule): string {
  const refs = [
    capsule.initiativeId ? `I:${capsule.initiativeId.slice(0, 8)}` : "",
    capsule.taskId ? `T:${capsule.taskId.slice(0, 8)}` : "",
    capsule.reviewer ? `reviewer=${capsule.reviewer}` : "",
    capsule.subsystem ? `subsystem=${capsule.subsystem}` : ""
  ].filter(Boolean).join(" ");
  return `[${capsule.status}] ${capsule.id.slice(0, 14)} ${capsule.ownerAgent} ${capsule.branch} "${capsule.goal}"${refs ? ` [${refs}]` : ""}`;
}

function isMergeStatus(value: string | undefined): value is MergeStatus {
  return value === "queued" || value === "testing" || value === "merged" || value === "conflict" || value === "failed";
}

function isSafeBranchName(value: string): boolean {
  return /^[a-zA-Z0-9_\-./]+$/.test(value);
}

function findMergeRequest(state: State, id: string | undefined): MergeRequest | undefined {
  if (!id) return undefined;
  return state.mergeQueue.find((request) => request.id === id || request.id.startsWith(id));
}

function formatMergeRequestLine(request: MergeRequest): string {
  const refs = [
    request.taskId ? `task=${request.taskId.slice(0, 12)}` : "",
    request.capsuleId ? `capsule=${request.capsuleId.slice(0, 14)}` : "",
    request.error ? `error=${request.error}` : ""
  ].filter(Boolean).join(" ");
  return `[${request.status}] ${request.id.slice(0, 14)} ${request.branch} -> ${request.targetBranch} by ${request.agentId}${refs ? ` [${refs}]` : ""}`;
}

function findEvaluation(state: State, id: string | undefined): EvaluationRecord | undefined {
  if (!id) return undefined;
  return state.evaluations.find((evaluation) => evaluation.id === id || evaluation.id.startsWith(id));
}

function formatEvaluationLine(evaluation: EvaluationRecord): string {
  const marker = evaluation.requiresHumanApproval ? "approval_required" : "auto_ok";
  const refs = [
    evaluation.artifactId ? `artifact=${evaluation.artifactId.slice(0, 14)}` : "",
    evaluation.initiativeId ? `initiative=${evaluation.initiativeId.slice(0, 14)}` : ""
  ].filter(Boolean).join(" ");
  return `[${marker}] ${evaluation.id.slice(0, 14)} selected=${evaluation.selectedOptionId} confidence=${formatNumber(evaluation.confidence)} tokens=${evaluation.tokensUsed}${refs ? ` [${refs}]` : ""}`;
}

function formatEvaluationSummary(evaluation: EvaluationRecord): string {
  return [
    `evaluation selected=${evaluation.selectedOptionId} confidence=${formatNumber(evaluation.confidence)} requiresApproval=${evaluation.requiresHumanApproval} tokens=${evaluation.tokensUsed}`,
    ...evaluation.scores.map((score) =>
      `- ${score.optionId} total=${score.totalScore.toFixed(2)} ${Object.entries(score.scores).map(([name, value]) => `${name}=${formatNumber(value)}`).join(" ")}${score.reasoning ? ` :: ${score.reasoning}` : ""}`
    )
  ].join("\n");
}

type RunFeedbackSummary = {
  agentId: string;
  runs: number;
  successRate: number;
  avgDurationMs: number;
  avgTokenCount: number;
  avgSteerCount: number;
  interventionRate: number;
  avgQualityScore?: number;
};

function findRunFeedback(state: State, id: string | undefined): RunFeedback | undefined {
  if (!id) return undefined;
  return state.runFeedback.find((feedback) => feedback.id === id || feedback.id.startsWith(id));
}

function parseRunFeedback(args: string[]): RunFeedback {
  const agentId = readOption(args, "--agent") || DEFAULT_AGENT.id;
  const durationMs = normalizeNonnegativeInt(readOption(args, "--duration-ms") || readOption(args, "--duration"));
  const tokenCount = normalizeNonnegativeInt(readOption(args, "--tokens") || readOption(args, "--token-count"));
  const steerCount = normalizeNonnegativeInt(readOption(args, "--steer-count"));
  const revisionCount = normalizeNonnegativeInt(readOption(args, "--revision-count") || readOption(args, "--revisions"));
  const outputQualityScore = readNumberOption(args, "--quality");
  if (outputQualityScore !== undefined && (outputQualityScore < 0 || outputQualityScore > 1)) {
    throw new Error("feedback quality must be between 0 and 1");
  }
  return {
    id: `feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    runId: readOption(args, "--run") || readOption(args, "--run-id"),
    agentId,
    taskId: readOption(args, "--task"),
    executionProfile: readOption(args, "--profile"),
    taskCompleted: readBooleanOption(args, "--completed") ?? true,
    durationMs,
    tokenCount,
    errored: readBooleanOption(args, "--errored") ?? false,
    humanIntervention: readBooleanOption(args, "--human-intervention") ?? false,
    steerCount,
    loopNumber: readOption(args, "--loop") ? normalizeNonnegativeInt(readOption(args, "--loop")) : undefined,
    acceptedByCeo: readBooleanOption(args, "--accepted-by-ceo"),
    acceptedByUser: readBooleanOption(args, "--accepted-by-user"),
    revisionCount,
    outputQualityScore,
    artifactReused: readBooleanOption(args, "--artifact-reused"),
    artifactLookupSuccess: readBooleanOption(args, "--artifact-lookup-success"),
    createdAt: Date.now()
  };
}

function formatRunFeedbackLine(feedback: RunFeedback): string {
  const status = feedback.errored ? "error" : feedback.taskCompleted ? "completed" : "incomplete";
  const refs = [
    feedback.runId ? `run=${feedback.runId}` : "",
    feedback.taskId ? `task=${feedback.taskId.slice(0, 12)}` : "",
    feedback.executionProfile ? `profile=${feedback.executionProfile}` : "",
    feedback.outputQualityScore !== undefined ? `quality=${formatNumber(feedback.outputQualityScore)}` : ""
  ].filter(Boolean).join(" ");
  return `[${status}] ${feedback.id.slice(0, 16)} agent=${feedback.agentId} tokens=${feedback.tokenCount} durationMs=${feedback.durationMs} steer=${feedback.steerCount} revisions=${feedback.revisionCount}${refs ? ` [${refs}]` : ""}`;
}

function summarizeRunFeedback(rows: RunFeedback[]): RunFeedbackSummary[] {
  const byAgent = new Map<string, RunFeedback[]>();
  for (const row of rows) byAgent.set(row.agentId, [...(byAgent.get(row.agentId) ?? []), row]);
  return [...byAgent.entries()].map(([agentId, agentRows]) => {
    const qualityRows = agentRows.filter((row) => row.outputQualityScore !== undefined);
    return {
      agentId,
      runs: agentRows.length,
      successRate: percent(agentRows.filter((row) => row.taskCompleted && !row.errored).length, agentRows.length),
      avgDurationMs: average(agentRows.map((row) => row.durationMs)),
      avgTokenCount: average(agentRows.map((row) => row.tokenCount)),
      avgSteerCount: average(agentRows.map((row) => row.steerCount)),
      interventionRate: percent(agentRows.filter((row) => row.humanIntervention).length, agentRows.length),
      avgQualityScore: qualityRows.length ? average(qualityRows.map((row) => row.outputQualityScore ?? 0)) : undefined
    };
  }).sort((a, b) => a.successRate - b.successRate || b.runs - a.runs);
}

function formatRunFeedbackSummaryLine(summary: RunFeedbackSummary): string {
  return [
    summary.agentId,
    `runs=${summary.runs}`,
    `successRate=${formatNumber(summary.successRate)}%`,
    `avgDurationMs=${Math.round(summary.avgDurationMs)}`,
    `avgTokens=${Math.round(summary.avgTokenCount)}`,
    `avgSteer=${formatNumber(summary.avgSteerCount)}`,
    `interventionRate=${formatNumber(summary.interventionRate)}%`,
    summary.avgQualityScore !== undefined ? `avgQuality=${formatNumber(summary.avgQualityScore)}` : ""
  ].filter(Boolean).join("\t");
}

function findReview(state: State, id: string | undefined): ReviewRecord | undefined {
  if (!id) return undefined;
  return state.reviews.find((review) => review.id === id || review.id.startsWith(id));
}

function parseReviewRecord(args: string[], capsule: ChangeCapsule): ReviewRecord {
  const coveragePct = normalizeBoundedNumber(readNumberOption(args, "--coverage") ?? 0, 0, 100);
  const checksPassed = readBooleanOption(args, "--checks") ?? true;
  const acceptanceMet = readBooleanOption(args, "--acceptance") ?? true;
  const scopeMatched = readBooleanOption(args, "--scope") ?? true;
  const testsMeaningful = readBooleanOption(args, "--tests") ?? true;
  const noRegressions = readBooleanOption(args, "--regressions") ?? true;
  const reasons = reviewFailureReasons({
    coveragePct,
    checksPassed,
    acceptanceMet,
    scopeMatched,
    testsMeaningful,
    noRegressions
  });
  return {
    id: `review-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    capsuleId: capsule.id,
    mergeId: readOption(args, "--merge"),
    reviewer: readOption(args, "--reviewer") || capsule.reviewer || "cto",
    coveragePct,
    checksPassed,
    acceptanceMet,
    scopeMatched,
    testsMeaningful,
    noRegressions,
    decision: reasons.length === 0 ? "approved" : "changes_requested",
    reasons,
    comment: readOption(args, "--comment"),
    createdAt: Date.now()
  };
}

function reviewFailureReasons(review: Pick<ReviewRecord, "coveragePct" | "checksPassed" | "acceptanceMet" | "scopeMatched" | "testsMeaningful" | "noRegressions">): string[] {
  return [
    review.coveragePct < REVIEW_COVERAGE_GATE ? `coverage below ${REVIEW_COVERAGE_GATE}%` : "",
    !review.checksPassed ? "checks failed" : "",
    !review.acceptanceMet ? "acceptance not met" : "",
    !review.scopeMatched ? "scope mismatch" : "",
    !review.testsMeaningful ? "tests not meaningful" : "",
    !review.noRegressions ? "regression risk" : ""
  ].filter(Boolean);
}

function formatReviewLine(review: ReviewRecord): string {
  const refs = [
    review.mergeId ? `merge=${review.mergeId.slice(0, 14)}` : "",
    review.reasons.length ? `reasons=${review.reasons.join("; ")}` : ""
  ].filter(Boolean).join(" ");
  return `[${review.decision}] ${review.id.slice(0, 14)} capsule=${review.capsuleId.slice(0, 14)} reviewer=${review.reviewer} coverage=${formatNumber(review.coveragePct)}%${refs ? ` [${refs}]` : ""}`;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percent(count: number, total: number): number {
  return total ? roundScore((count / total) * 100) : 0;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function normalizeDir(pathValue: string): string {
  const parts = pathValue.split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

function capsuleConflictLevel(left: ChangeCapsule, right: ChangeCapsule): "parallel_ok" | "weak_conflict" | "high_conflict" {
  const leftPaths = new Set(left.allowedPaths);
  const rightPaths = new Set(right.allowedPaths);
  for (const pathValue of leftPaths) {
    if (rightPaths.has(pathValue)) return "high_conflict";
  }
  if (left.subsystem && right.subsystem && left.subsystem === right.subsystem) return "weak_conflict";
  const rightDirs = new Set([...rightPaths].map(normalizeDir).filter(Boolean));
  const sharedDir = [...leftPaths].map(normalizeDir).filter(Boolean).some((dir) => rightDirs.has(dir));
  return sharedDir ? "weak_conflict" : "parallel_ok";
}

function capsuleConflicts(state: State, capsule: ChangeCapsule): { id: string; level: "weak_conflict" | "high_conflict" }[] {
  return state.capsules
    .filter((row) => row.id !== capsule.id && (row.status === "open" || row.status === "in_review"))
    .map((row) => ({ id: row.id, level: capsuleConflictLevel(capsule, row) }))
    .filter((row): row is { id: string; level: "weak_conflict" | "high_conflict" } => row.level !== "parallel_ok");
}

function findArtifact(state: State, id: string | undefined): Artifact | undefined {
  if (!id) return undefined;
  return state.artifacts.find((artifact) => artifact.id === id || artifact.id.startsWith(id));
}

function artifactCandidateFromArgs(args: string[]): Pick<Artifact, "kind" | "path" | "source" | "confidence" | "metadata" | "content"> | null {
  const kind = readOption(args, "--kind");
  const path = readOption(args, "--path");
  const source = readOption(args, "--source");
  const confidence = Number.parseFloat(readOption(args, "--confidence") || "");
  if (!kind || !path || !source || !Number.isFinite(confidence)) return null;
  return {
    kind,
    path,
    source,
    confidence,
    metadata: parseMetadataJson(args) ?? {},
    content: readOption(args, "--content")
  };
}

function checkArtifactQuality(artifact: Pick<Artifact, "kind" | "path" | "source" | "confidence" | "metadata" | "content">): ArtifactQualityCheck {
  const warnings: string[] = [];
  if (!STANDARD_ARTIFACT_KINDS.has(artifact.kind)) warnings.push(`non-standard kind: ${artifact.kind}`);
  if (!isThreePartArtifactPath(artifact.path)) warnings.push("path should use domain/category/item");
  if (!isKnownArtifactSource(artifact.source)) warnings.push(`source is not a recognized identifier: ${artifact.source}`);
  if (artifact.source === "training_data" && artifact.confidence > 0.3) warnings.push("training_data confidence should be <= 0.3");
  if (artifact.source === "estimate" && artifact.confidence > 0.5) warnings.push("estimate confidence should be <= 0.5");
  if (artifact.source.startsWith("web_search:") && artifact.confidence > 0.7 && artifact.metadata.source !== "cross_validated") {
    warnings.push("single web_search confidence should be <= 0.7 unless cross_validated");
  }
  if ((artifact.source === "government_data" || artifact.source === "cross_validated") && artifact.confidence < 0.8) {
    warnings.push(`${artifact.source} usually deserves confidence >= 0.8`);
  }
  if (!hasMetadataDate(artifact.metadata)) warnings.push("metadata should include collection date or verified_at");
  if (requiresUnits(artifact.kind, artifact.path, artifact.metadata)) warnings.push("metadata should include units such as currency, period, or unit");
  if (artifact.kind === "brand_asset" && !artifact.content && typeof artifact.metadata.name !== "string") {
    warnings.push("brand_asset should include content or metadata.name");
  }
  return {
    valid: warnings.length === 0,
    warnings,
    score: Math.max(0, roundScore(1 - warnings.length * 0.12))
  };
}

function isThreePartArtifactPath(pathValue: string): boolean {
  return pathValue.split("/").filter(Boolean).length >= 3;
}

function isKnownArtifactSource(source: string): boolean {
  return source === "training_data" ||
    source === "estimate" ||
    source.startsWith("web_search:") ||
    source === "government_data" ||
    source === "industry_report" ||
    source.startsWith("api:") ||
    source === "cross_validated" ||
    source === "marketing" ||
    source === DEFAULT_AGENT.id ||
    source === LEGACY_DEFAULT_AGENT_ID ||
    source === "original";
}

function hasMetadataDate(metadata: Record<string, unknown>): boolean {
  return typeof metadata.collected_at === "string" ||
    typeof metadata.collectedAt === "string" ||
    typeof metadata.date === "string" ||
    typeof metadata.verified_at === "string" ||
    typeof metadata.verifiedAt === "string";
}

function requiresUnits(kind: string, pathValue: string, metadata: Record<string, unknown>): boolean {
  const financial = kind === "budget_item" ||
    kind === "revenue_forecast" ||
    kind === "financial_summary" ||
    pathValue.startsWith("costs/") ||
    pathValue.startsWith("revenue/") ||
    pathValue.startsWith("finance/");
  if (!financial) return false;
  return typeof metadata.currency !== "string" &&
    typeof metadata.unit !== "string" &&
    typeof metadata.period !== "string";
}

function formatArtifactQualityCheck(check: ArtifactQualityCheck): string {
  return [
    `artifact quality valid=${check.valid} score=${formatNumber(check.score)}`,
    ...(check.warnings.length ? check.warnings.map((warning) => `- ${warning}`) : ["- no warnings"])
  ].join("\n");
}

function parseMetadataJson(args: string[]): Record<string, unknown> | null {
  const optionsWithValue = new Set(["--kind", "--path", "--source", "--confidence", "--task", "--content", "--agent"]);
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i] || "";
    if (optionsWithValue.has(arg)) {
      i += 1;
      continue;
    }
    if (arg === "--allow-nonstandard" || arg === "--unverified") continue;
    positionals.push(arg);
  }
  const raw = positionals.at(-1);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function formatArtifactLine(artifact: Artifact): string {
  const task = artifact.taskId ? ` task=${artifact.taskId}` : "";
  const verification = artifact.verified ? "verified" : "unverified";
  return `[${verification}] ${artifact.id.slice(0, 14)} ${artifact.kind} ${artifact.path} source=${artifact.source} confidence=${artifact.confidence}${task}`;
}

function isHypothesisStatus(value: string): value is HypothesisStatus {
  return value === "proposed" || value === "active" || value === "validated" || value === "rejected" || value === "abandoned";
}

function findHypothesis(state: State, id: string | undefined): Hypothesis | undefined {
  if (!id) return undefined;
  return state.hypotheses.find((hypothesis) => hypothesis.id === id || hypothesis.id.startsWith(id));
}

function formatHypothesisLine(hypothesis: Hypothesis): string {
  const parent = hypothesis.parentId ? ` parent=${hypothesis.parentId}` : "";
  const evidence = hypothesis.evidenceArtifactIds?.length ? ` evidence=${hypothesis.evidenceArtifactIds.join(",")}` : "";
  const outcome = hypothesis.outcome ? ` outcome=${hypothesis.outcome.slice(0, 80)}` : "";
  return `[${hypothesis.status}] ${hypothesis.id.slice(0, 14)} ${hypothesis.title}${parent}${evidence}${outcome}`;
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/.exec(trimmed);
  return match ? match[1] || "" : trimmed;
}

function firstJsonArg(args: string[]): string | undefined {
  return args.find((arg) => {
    const trimmed = arg.trim();
    return trimmed.startsWith("{") || trimmed.startsWith("```");
  });
}

function parseExecutionPlan(raw: string): ExecutionPlan {
  if (!raw.trim()) throw new Error("usage: king plan parse|apply '<json plan>'");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error(`Failed to parse plan JSON: ${raw.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    throw new Error("Invalid execution plan: expected object with tasks array");
  }
  const rec = parsed as { optionId?: unknown; tasks: unknown[]; totalEstimatedTokens?: unknown };
  if (rec.tasks.length === 0) throw new Error("Invalid execution plan: tasks array is empty");
  const tasks = rec.tasks.map((item, index) => parsePlannedTask(item, index));
  const totalEstimatedTokens = typeof rec.totalEstimatedTokens === "number"
    ? Math.max(0, rec.totalEstimatedTokens)
    : tasks.reduce((sum, task) => sum + task.estimatedTokens, 0);
  return {
    optionId: typeof rec.optionId === "string" && rec.optionId.trim() ? rec.optionId : `plan-${Date.now()}`,
    tasks,
    totalEstimatedTokens
  };
}

function parsePlannedTask(item: unknown, index: number): PlannedTask {
  if (!item || typeof item !== "object") throw new Error(`Invalid execution plan: task ${index} is not an object`);
  const rec = item as Record<string, unknown>;
  if (typeof rec.title !== "string" || !rec.title.trim()) throw new Error(`Invalid execution plan: task ${index} missing title`);
  if (typeof rec.description !== "string") throw new Error(`Invalid execution plan: task ${index} missing description`);
  const scope = rec.scope;
  if (!scope || typeof scope !== "object" || !Array.isArray((scope as { paths?: unknown }).paths)) {
    throw new Error(`Invalid execution plan: task ${index} missing scope.paths`);
  }
  const scopeRec = scope as { paths: unknown[]; patterns?: unknown };
  const paths = scopeRec.paths.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const patterns = Array.isArray(scopeRec.patterns)
    ? scopeRec.patterns.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : undefined;
  const dependencies = Array.isArray(rec.dependencies)
    ? rec.dependencies.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const estimatedTokens = typeof rec.estimatedTokens === "number" ? Math.max(0, rec.estimatedTokens) : 0;
  const priority = typeof rec.priority === "number" ? Math.max(1, Math.min(10, Math.round(rec.priority))) : 5;
  return {
    title: rec.title,
    description: rec.description,
    scope: patterns?.length ? { paths, patterns } : { paths },
    dependencies,
    estimatedTokens,
    priority
  };
}

function parseEvaluationRecord(raw: string, refs: { artifactId?: string; initiativeId?: string } = {}): EvaluationRecord {
  if (!raw.trim()) throw new Error("usage: king eval parse|record '<json evaluation>'");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error(`Failed to parse evaluation JSON: ${raw.slice(0, 120)}`);
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { scores?: unknown }).scores)) {
    throw new Error("Invalid evaluation: expected object with scores array");
  }
  const rec = parsed as Record<string, unknown>;
  const rawScores = rec.scores as unknown[];
  if (rawScores.length === 0) throw new Error("Invalid evaluation: scores array is empty");
  const criteria = parseEvaluationCriteria(rec.criteria);
  const scores = rawScores.map((item, index) => parseEvaluationScore(item, index, criteria));
  const selectedOptionId = typeof rec.selectedOptionId === "string" && rec.selectedOptionId.trim()
    ? rec.selectedOptionId
    : scores.slice().sort((a, b) => b.totalScore - a.totalScore)[0]?.optionId ?? "";
  if (!scores.some((score) => score.optionId === selectedOptionId)) throw new Error(`Invalid evaluation: selected option not found: ${selectedOptionId}`);
  const confidence = normalizeBoundedNumber(typeof rec.confidence === "number" ? rec.confidence : 0, 0, 1);
  const tokensUsed = typeof rec.tokensUsed === "number"
    ? Math.max(0, Math.round(rec.tokensUsed))
    : typeof rec.tokens_used === "number"
      ? Math.max(0, Math.round(rec.tokens_used))
      : 0;
  return {
    id: `eval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    scores,
    selectedOptionId,
    confidence,
    tokensUsed,
    requiresHumanApproval: confidence < 0.7,
    criteria,
    artifactId: refs.artifactId,
    initiativeId: refs.initiativeId,
    createdAt: Date.now()
  };
}

function parseEvaluationCriteria(raw: unknown): EvaluationCriteria[] {
  if (!Array.isArray(raw)) return DEFAULT_EVALUATION_CRITERIA;
  const criteria: EvaluationCriteria[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || !rec.name.trim() || typeof rec.weight !== "number") continue;
    criteria.push({
      name: rec.name.trim(),
      weight: Math.max(0, rec.weight),
      description: typeof rec.description === "string" ? rec.description : undefined
    });
  }
  return criteria.length ? criteria : DEFAULT_EVALUATION_CRITERIA;
}

function parseEvaluationScore(item: unknown, index: number, criteria: EvaluationCriteria[]): EvaluationScore {
  if (!item || typeof item !== "object") throw new Error(`Invalid evaluation: score ${index} is not an object`);
  const rec = item as Record<string, unknown>;
  if (typeof rec.optionId !== "string" || !rec.optionId.trim()) throw new Error(`Invalid evaluation: score ${index} missing optionId`);
  if (!rec.scores || typeof rec.scores !== "object" || Array.isArray(rec.scores)) throw new Error(`Invalid evaluation: score ${index} missing scores object`);
  const rawScores = rec.scores as Record<string, unknown>;
  const scores: Record<string, number> = {};
  for (const criterion of criteria) {
    scores[criterion.name] = normalizeBoundedNumber(typeof rawScores[criterion.name] === "number" ? rawScores[criterion.name] as number : 0, 0, 10);
  }
  return {
    optionId: rec.optionId.trim(),
    scores,
    totalScore: roundScore(criteria.reduce((sum, criterion) => sum + (scores[criterion.name] ?? 0) * criterion.weight, 0)),
    reasoning: typeof rec.reasoning === "string" ? rec.reasoning : ""
  };
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeBoundedNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function isSafetyAction(value: string | undefined): value is SafetyAction {
  return Boolean(value && SAFETY_ACTIONS.has(value as SafetyAction));
}

function safetyCheck(action: SafetyAction): { allowed: boolean; requiresApproval: boolean } {
  return SAFETY_AUTO_ALLOW.has(action)
    ? { allowed: true, requiresApproval: false }
    : { allowed: false, requiresApproval: true };
}

function parseSafetyContext(args: string[]): Record<string, unknown> {
  const raw = readOption(args, "--context");
  const reason = readOption(args, "--reason");
  let context: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) context = parsed as Record<string, unknown>;
      else context = { value: raw };
    } catch {
      context = { value: raw };
    }
  }
  if (reason) context.reason = reason;
  return context;
}

function stringContextValue(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findApproval(state: State, id: string | undefined): ApprovalRequest | undefined {
  if (!id) return undefined;
  return state.approvals.find((approval) => approval.id === id || approval.id.startsWith(id));
}

function formatApprovalLine(approval: ApprovalRequest): string {
  const reason = approval.reason ? ` reason=${approval.reason}` : typeof approval.context.reason === "string" ? ` reason=${approval.context.reason}` : "";
  return `[${approval.status}] ${approval.id.slice(0, 18)} action=${approval.action}${reason}`;
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function readBooleanOption(args: string[], name: string): boolean | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
  if (value === "0" || value === "false" || value === "no" || value === "off") return false;
  return undefined;
}

function readNumberOption(args: string[], name: string): number | undefined {
  const raw = readOption(args, name);
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeNonnegativeInt(value: string | undefined): number {
  const parsed = Number.parseInt(value || "0", 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalizePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripOptions(args: string[], optionNames: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (optionNames.includes(args[i] || "")) {
      i += 1;
      continue;
    }
    result.push(args[i] || "");
  }
  return result;
}

function parseAllowedPaths(args: string[]): string[] {
  const raw = readOption(args, "--paths") || readOption(args, "--path") || "";
  return raw
    .split(",")
    .map((path) => path.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .filter((path, idx, all) => all.indexOf(path) === idx);
}

function pathsOverlap(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, "");
  const right = b.replace(/\/+$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathConflict(state: State, paths: string[], owner: string, exceptCardId?: string): string | null {
  if (paths.length === 0) return null;
  for (const card of state.cards) {
    if (card.id === exceptCardId || card.column === "done" || !card.claimedBy || card.claimedBy === owner) continue;
    const overlap = (card.allowedPaths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `card ${card.id} claimed by ${card.claimedBy} already covers ${overlap}`;
  }
  for (const claim of state.claims) {
    if (claim.owner === owner) continue;
    const overlap = (claim.allowedPaths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `claim ${claim.id} held by ${claim.owner} already covers ${overlap}`;
  }
  for (const task of state.tasks) {
    if (task.status === "done" || task.status === "failed" || task.assignee === owner) continue;
    const overlap = (task.scope?.paths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `task ${task.id} assigned to ${task.assignee || "unassigned"} already covers ${overlap}`;
  }
  for (const capsule of state.capsules) {
    if (capsule.status !== "open" && capsule.status !== "in_review") continue;
    if (capsule.ownerAgent === owner) continue;
    const overlap = capsule.allowedPaths.find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) return `capsule ${capsule.id} owned by ${capsule.ownerAgent} already covers ${overlap}`;
  }
  return null;
}

function taskScopeConflicts(state: State, task: Task, owner?: string): string[] {
  const paths = task.scope?.paths ?? [];
  if (paths.length === 0) return [];
  const conflicts: string[] = [];
  for (const other of state.tasks) {
    if (other.id === task.id || other.status === "done" || other.status === "failed") continue;
    if (owner && other.assignee === owner) continue;
    const overlap = (other.scope?.paths ?? []).find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) conflicts.push(`task ${other.id} overlaps ${overlap}`);
  }
  for (const capsule of state.capsules) {
    if (capsule.status !== "open" && capsule.status !== "in_review") continue;
    if (owner && capsule.ownerAgent === owner) continue;
    const overlap = capsule.allowedPaths.find((path) => paths.some((candidate) => pathsOverlap(candidate, path)));
    if (overlap) conflicts.push(`capsule ${capsule.id} overlaps ${overlap}`);
  }
  return conflicts;
}

function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function requestKeepAlive(writer: WritableStreamDefaultWriter<Uint8Array>, cleanup: () => void): void {
  const tick = async () => {
    try {
      await writer.write(encode(": keepalive\n\n"));
      setTimeout(tick, 15000);
    } catch {
      cleanup();
    }
  };
  setTimeout(tick, 15000);
}

export default app;
