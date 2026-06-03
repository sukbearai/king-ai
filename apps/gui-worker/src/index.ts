/// <reference types="@cloudflare/workers-types" />

import { Hono } from "hono";
import { cors } from "hono/cors";
import { renderPage } from "./page.js";
import { cronMatches, parseCron } from "@suwujs/king/cron";
import { formatMessageRouteSummary, messageRouteTag, sortRuntimeMessages } from "@suwujs/king/message-routing";

type Bindings = {
  GUI_STATE: DurableObjectNamespace;
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
  priority?: "normal" | "steer";
  message_type?: "message" | "decision" | "blocker";
  to_agent_id?: string;
  quoted_message_id?: string;
  payload?: unknown;
  created_at: number;
  readBy: string[];
};

type Conversation = {
  id: string;
  title: string;
  kind: "direct" | "group";
  created_at: number;
  updated_at: number;
  order?: number;
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

type TaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed";
type CapsuleStatus = "open" | "in_review" | "merged" | "abandoned";
type CapsuleScopeType = "code" | "docs" | "tests" | "ops" | "mixed";
type MergeStatus = "queued" | "testing" | "merged" | "conflict" | "failed";

type Task = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignee?: string;
  priority: number;
  parentId?: string;
  dependsOn?: string[];
  result?: string;
  initiativeId?: string;
  capsuleId?: string;
  subsystem?: string;
  scope?: { paths?: string[]; patterns?: string[] };
  executionProfile?: string;
  created_at: number;
  updated_at: number;
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
  createdAt: number;
  resolvedAt?: number;
  reason?: string;
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
  pairingCode: string;
  availableEngines: string[];
  capabilities: { workspaces: string[]; agentWorkspaceRoot?: string };
  lastHeartbeat?: { at: number; version?: string; capabilities?: { workspaces: string[]; agentWorkspaceRoot?: string } };
  agentConfigUpdatedAt?: number;
  agents: Agent[];
  conversations: Conversation[];
  messages: Message[];
  cliLog: { at: number; agentId: string; argv: string[]; result: string }[];
  statusLog: { at: number; status: string }[];
  typingLog: { at: number; conversationId?: string; done?: boolean }[];
  thinkingLog: { at: number; action: "mark" | "unmark"; conversationIds: string[] }[];
  eventLog: { at: number; body: unknown }[];
  eventRoutes: EventRoute[];
  loopRunId: string;
  currentLoop: number;
  loopEvents: LoopEvent[];
  noticeLog: { at: number; body: unknown }[];
  triageLog: { at: number; body: unknown }[];
  runLog: { at: number; runId: string; action: "start" | "heartbeat" | "finish"; body?: unknown }[];
  initiatives: Initiative[];
  tasks: Task[];
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
  priority?: unknown;
  paths?: unknown;
  wake?: unknown;
};

type GuiTaskUpdatePayload = {
  status?: unknown;
  assignee?: unknown;
  result?: unknown;
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
  id: "king-agent",
  name: "King Agent",
  role: "Local BYOA agent",
  engine: "codex",
  lifecycle: "on-demand"
};

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

const styles = "    :root {\n      --accent: #ffd633;\n      --rail: #ffd83d;\n      --sidebar: #fbf4e6;\n      --active: #f15b93;\n      --canvas: #ffffff;\n      --panel: #fffaf0;\n      --line: #111111;\n      --soft-line: #d7d1c5;\n      --ink: #171717;\n      --body: #303030;\n      --muted: #7d7a73;\n      --avatar: #c8b6ff;\n      --shadow: rgba(17,17,17,0.16) 0 14px 36px;\n    }\n    * { box-sizing: border-box; }\n    body {\n      margin: 0;\n      background: var(--canvas);\n      color: var(--ink);\n      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif;\n      font-size: 12px;\n      line-height: 1.35;\n      overflow: hidden;\n    }\n    h1, h2, h3, p { margin: 0; }\n    h1 { font-size: 17px; line-height: 1.1; }\n    h2 { font-size: 15px; line-height: 1.2; }\n    h3 { font-size: 13px; line-height: 1.2; }\n    p { color: var(--body); }\n    button, textarea, select, input { font: inherit; }\n    * {\n      scrollbar-width: thin;\n      scrollbar-color: var(--line) var(--accent);\n    }\n    *::-webkit-scrollbar {\n      width: 13px;\n      height: 13px;\n    }\n    *::-webkit-scrollbar-track {\n      background: var(--accent);\n      border-left: 1px solid var(--line);\n    }\n    *::-webkit-scrollbar-thumb {\n      background: var(--line);\n      border: 3px solid var(--accent);\n    }\n    *::-webkit-scrollbar-corner { background: var(--accent); }\n    button {\n      min-height: 27px;\n      border: 1px solid var(--line);\n      border-radius: 0;\n      padding: 4px 9px;\n      background: var(--canvas);\n      color: var(--ink);\n      font-weight: 800;\n      cursor: pointer;\n    }\n    button:hover, button.primary { background: var(--accent); }\n    button.icon {\n      width: 27px;\n      min-width: 27px;\n      padding: 0;\n      display: grid;\n      place-items: center;\n    }\n    textarea, input, select {\n      width: 100%;\n      border: 1px solid var(--line);\n      border-radius: 0;\n      background: var(--canvas);\n      color: var(--ink);\n      padding: 8px;\n    }\n    textarea {\n      min-height: 54px;\n      resize: vertical;\n      line-height: 1.45;\n    }\n    label {\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n      text-transform: uppercase;\n    }\n    .app {\n      height: 100vh;\n      min-height: 100vh;\n      display: grid;\n      grid-template-columns: 42px 180px minmax(0, 1fr);\n      background: var(--canvas);\n    }\n    .rail {\n      display: grid;\n      grid-template-rows: auto 1fr;\n      gap: 12px;\n      border-right: 2px solid var(--line);\n      background: var(--rail);\n      padding: 8px 6px;\n    }\n    .logo {\n      width: 27px;\n      display: grid;\n      grid-template-columns: 1fr;\n      gap: 6px;\n    }\n    .logo span {\n      width: 27px;\n      height: 27px;\n      display: grid;\n      place-items: center;\n      background: var(--line);\n      color: var(--accent);\n      font-size: 10px;\n      font-weight: 900;\n    }\n    .rail .icon { background: transparent; border-color: transparent; }\n    .rail .icon.active { background: var(--canvas); border-color: var(--line); }\n    .windows {\n      min-width: 0;\n      border-right: 2px solid var(--line);\n      background: var(--sidebar);\n      padding: 8px 6px;\n      overflow: hidden;\n      display: grid;\n      grid-template-rows: auto minmax(0, 1fr);\n      gap: 8px;\n    }\n    .windows-head {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 8px;\n      padding: 0 2px 8px;\n      border-bottom: 1px solid var(--soft-line);\n      font-weight: 900;\n    }\n    .window-list {\n      min-height: 0;\n      overflow: auto;\n      display: grid;\n      align-content: start;\n      gap: 5px;\n    }\n    .window-item {\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto auto;\n      gap: 6px;\n      align-items: center;\n      min-height: 32px;\n      padding: 5px 6px;\n      border: 1px solid transparent;\n      background: transparent;\n      text-align: left;\n      font-weight: 800;\n    }\n    .window-select {\n      min-width: 0;\n      min-height: 0;\n      padding: 0;\n      border: 0;\n      background: transparent;\n      text-align: left;\n      font-weight: 900;\n    }\n    .window-item.active {\n      border-color: var(--line);\n      background: var(--active);\n    }\n    .window-delete {\n      width: 18px;\n      min-width: 18px;\n      min-height: 18px;\n      padding: 0;\n      border-color: var(--line);\n      background: var(--canvas);\n      color: var(--line);\n      line-height: 1;\n    }\n    .window-delete:hover { background: var(--accent); }\n    .window-name {\n      overflow: hidden;\n      text-overflow: ellipsis;\n      white-space: nowrap;\n    }\n    .window-meta {\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n    }\n    .sidebar {\n      display: none;\n      min-width: 0;\n      border-right: 2px solid var(--line);\n      background: var(--sidebar);\n      padding: 9px 5px;\n      overflow: hidden;\n    }\n    .side-title {\n      display: flex;\n      justify-content: space-between;\n      align-items: center;\n      padding: 0 4px 11px;\n      border-bottom: 1px solid var(--soft-line);\n      margin-bottom: 8px;\n    }\n    .side-section { display: grid; gap: 3px; margin: 12px 0; }\n    .side-label {\n      padding: 0 7px;\n      color: var(--muted);\n      font-size: 10px;\n      font-weight: 900;\n      letter-spacing: 0.03em;\n      text-transform: uppercase;\n    }\n    .side-link, .channel {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 8px;\n      min-height: 25px;\n      padding: 4px 6px;\n      border: 1px solid transparent;\n      color: var(--body);\n      text-decoration: none;\n      white-space: nowrap;\n      overflow: hidden;\n    }\n    .channel.active {\n      background: var(--active);\n      border-color: var(--line);\n      color: var(--line);\n      font-weight: 900;\n    }\n    .badge { color: var(--muted); font-size: 10px; font-weight: 900; }\n    .main {\n      min-width: 0;\n      min-height: 0;\n      height: 100vh;\n      display: grid;\n      grid-template-rows: auto auto minmax(0, 1fr);\n    }\n    .topbar {\n      height: 38px;\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 14px;\n      border-bottom: 2px solid var(--line);\n      padding: 6px 12px;\n    }\n    .channel-head {\n      display: grid;\n      grid-template-columns: 21px minmax(0, auto);\n      gap: 8px;\n      align-items: center;\n      min-width: 0;\n    }\n    .hash {\n      width: 21px;\n      height: 21px;\n      display: grid;\n      place-items: center;\n      background: var(--accent);\n      border: 1px solid var(--line);\n      font-weight: 900;\n    }\n    .channel-name { font-weight: 900; line-height: 1; }\n    .channel-desc {\n      color: var(--muted);\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 10px;\n      overflow: hidden;\n      text-overflow: ellipsis;\n      white-space: nowrap;\n    }\n    .top-actions { display: flex; gap: 6px; }\n    .tabs {\n      height: 24px;\n      display: flex;\n      align-items: stretch;\n      border-bottom: 2px solid var(--line);\n    }\n    .tab {\n      min-height: 0;\n      padding: 3px 12px;\n      border-width: 0 1px 0 0;\n      background: var(--canvas);\n      font-size: 11px;\n    }\n    .tab.active { background: var(--accent); }\n    .workspace {\n      min-height: 0;\n      overflow: auto;\n      background: var(--canvas);\n    }\n    .panel { display: none; min-height: 100%; }\n    .panel.active { display: block; }\n    .chat-panel {\n      position: relative;\n      min-height: 100%;\n      padding: 14px 0 124px;\n    }\n    .message-list {\n      display: grid;\n      gap: 11px;\n      width: 100%;\n      padding: 0 18px;\n    }\n    .system-line {\n      color: #aaa49a;\n      font-size: 10px;\n      text-align: center;\n      padding: 4px 0;\n    }\n    .post {\n      display: grid;\n      grid-template-columns: 24px minmax(0, 1fr);\n      gap: 8px;\n      padding: 8px;\n      border: 1px solid transparent;\n    }\n    .post.highlight { border-color: var(--line); }\n    .avatar {\n      width: 22px;\n      height: 22px;\n      display: grid;\n      place-items: center;\n      border: 1px solid var(--line);\n      background: var(--avatar);\n      color: var(--line);\n      font-size: 12px;\n      font-weight: 900;\n    }\n    .post-top {\n      display: flex;\n      align-items: baseline;\n      gap: 6px;\n      min-width: 0;\n      margin-bottom: 3px;\n    }\n    .author { font-weight: 900; }\n    .time { color: var(--muted); font-size: 10px; white-space: nowrap; }\n    .post-body {\n      color: var(--body);\n      line-height: 1.45;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .jump {\n      position: sticky;\n      bottom: 104px;\n      display: none;\n      width: max-content;\n      margin: 16px auto;\n      box-shadow: var(--shadow);\n    }\n    .jump.visible { display: block; }\n    .composer {\n      position: fixed;\n      right: 16px;\n      bottom: 14px;\n      left: 238px;\n      z-index: 5;\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto;\n      gap: 8px;\n      width: auto;\n      max-width: none;\n      border: 2px solid var(--line);\n      background: var(--canvas);\n      padding: 8px;\n    }\n    .composer textarea {\n      min-height: 44px;\n      max-height: 110px;\n      border: 0;\n      padding: 6px;\n    }\n    .composer button:disabled {\n      opacity: 0.62;\n      cursor: wait;\n    }\n    .tab-panel {\n      max-width: 920px;\n      padding: 18px;\n      gap: 10px;\n    }\n    .tab-panel.active { display: grid; }\n    .task-row {\n      display: grid;\n      gap: 5px;\n      max-width: 720px;\n      border: 1px solid var(--line);\n      padding: 10px;\n    }\n    .task-top {\n      display: flex;\n      align-items: baseline;\n      justify-content: space-between;\n      gap: 10px;\n    }\n    .model-grid { display: grid; gap: 10px; }\n    .model-row {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 12px;\n      border-top: 1px solid var(--soft-line);\n      padding-top: 8px;\n      color: var(--body);\n    }\n    .model-row:first-child { border-top: 0; padding-top: 0; }\n    .available { color: #cc2f68; font-weight: 900; }\n    .unavailable { color: var(--muted); }\n    .cmd {\n      border: 1px solid var(--line);\n      background: var(--panel);\n      padding: 10px;\n      color: var(--body);\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 11px;\n      line-height: 1.5;\n      overflow: auto;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .side-card {\n      display: grid;\n      gap: 10px;\n      border: 1px solid var(--line);\n      padding: 10px;\n    }\n    .settings-actions {\n      display: flex;\n      justify-content: flex-end;\n      gap: 8px;\n    }\n    .field { display: grid; gap: 5px; }\n    .muted { color: var(--muted); font-size: 11px; }\n    dialog {\n      width: min(520px, calc(100vw - 24px));\n      max-height: min(760px, calc(100vh - 24px));\n      border: 2px solid var(--line);\n      border-radius: 0;\n      padding: 0;\n      box-shadow: var(--shadow);\n      overflow: hidden;\n    }\n    dialog::backdrop { background: rgba(0,0,0,0.48); }\n    .computer-dialog { width: min(680px, calc(100vw - 24px)); }\n    .window-dialog { width: min(440px, calc(100vw - 24px)); }\n    .modal-form { margin: 0; }\n    .modal-head {\n      display: flex;\n      align-items: center;\n      justify-content: space-between;\n      gap: 16px;\n      padding: 12px;\n      border-bottom: 2px solid var(--line);\n    }\n    .modal-body {\n      display: grid;\n      gap: 12px;\n      padding: 12px;\n      overflow: auto;\n      max-height: calc(100vh - 120px);\n    }\n    .computer-flow {\n      display: grid;\n      gap: 20px;\n      padding: 32px;\n    }\n    .computer-kicker {\n      color: var(--muted);\n      font-size: 11px;\n      font-weight: 900;\n      letter-spacing: 0.14em;\n      text-transform: uppercase;\n    }\n    .computer-title {\n      font-size: 20px;\n      line-height: 1.15;\n      text-transform: uppercase;\n    }\n    .computer-lead {\n      display: grid;\n      grid-template-columns: 36px minmax(0, 1fr);\n      gap: 14px;\n      align-items: start;\n      color: var(--body);\n      font-size: 15px;\n      line-height: 1.5;\n    }\n    .computer-icon {\n      width: 32px;\n      height: 32px;\n      display: grid;\n      place-items: center;\n      border: 2px solid var(--line);\n      background: var(--accent);\n      font-weight: 900;\n    }\n    .computer-muted {\n      margin-top: 8px;\n      color: var(--muted);\n      font-size: 12px;\n      line-height: 1.45;\n    }\n    .computer-rule { border-top: 2px solid var(--soft-line); }\n    .computer-actions {\n      display: flex;\n      align-items: center;\n      justify-content: flex-end;\n      gap: 12px;\n      flex-wrap: wrap;\n    }\n    .computer-actions.between { justify-content: space-between; }\n    .check-row {\n      display: flex;\n      align-items: center;\n      gap: 8px;\n      font-weight: 800;\n      color: var(--body);\n    }\n    .check-row input {\n      width: 16px;\n      height: 16px;\n      padding: 0;\n      accent-color: var(--accent);\n    }\n    .choice-grid {\n      display: grid;\n      grid-template-columns: repeat(2, minmax(0, 1fr));\n      gap: 10px;\n    }\n    .computer-choice {\n      display: grid;\n      grid-template-columns: 28px minmax(0, 1fr);\n      gap: 10px;\n      min-height: 82px;\n      border: 2px solid var(--line);\n      padding: 14px;\n      background: var(--canvas);\n      text-align: left;\n    }\n    .computer-choice.active { background: var(--accent); }\n    .computer-choice.disabled {\n      border-style: dashed;\n      color: var(--muted);\n      opacity: 0.56;\n      cursor: default;\n    }\n    .computer-choice-title {\n      display: block;\n      font-size: 14px;\n      text-transform: uppercase;\n    }\n    .connect-row {\n      display: grid;\n      grid-template-columns: minmax(0, 1fr) auto;\n      gap: 10px;\n      align-items: center;\n    }\n    .connect-stack {\n      display: grid;\n      gap: 8px;\n      min-width: 0;\n    }\n    .connect-help {\n      color: var(--body);\n      font-size: 12px;\n      font-weight: 900;\n    }\n    .connect-command {\n      border: 2px solid var(--line);\n      background: #080808;\n      color: #a7d66d;\n      padding: 14px;\n      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;\n      font-size: 12px;\n      line-height: 1.5;\n      white-space: pre-wrap;\n      word-break: break-word;\n    }\n    .connect-status {\n      display: flex;\n      align-items: center;\n      gap: 10px;\n      border: 2px solid var(--line);\n      background: #fff3c4;\n      padding: 14px;\n      font-weight: 900;\n    }\n    .status-dot {\n      width: 10px;\n      height: 10px;\n      border: 2px solid var(--line);\n      border-radius: 50%;\n      background: #ffad7a;\n    }\n    .status-dot.online { background: #74d67b; }\n    .button-shadow { box-shadow: 4px 5px 0 var(--line); }\n    button.primary-pink {\n      background: var(--active);\n      min-height: 36px;\n      padding: 8px 14px;\n      font-size: 14px;\n    }\n    button.disabled-action {\n      background: #edf5df;\n      color: var(--muted);\n      cursor: default;\n    }\n    @media (max-width: 760px) {\n      .app { grid-template-columns: 36px 132px minmax(0, 1fr); }\n      .logo {\n        width: 24px;\n        grid-template-columns: 1fr;\n      }\n      .logo span {\n        width: 22px;\n        height: 16px;\n        font-size: 10px;\n      }\n      .message-list { padding: 0 10px; }\n      .composer { left: 178px; right: 10px; width: auto; }\n      .top-actions .hide-mobile { display: none; }\n      .post { max-width: 100%; }\n      .computer-flow { padding: 22px; }\n      .choice-grid, .connect-row { grid-template-columns: 1fr; }\n    }\n";

const clientScript = "const base = location.origin;\nlet pairCommand = '';\nlet pairCommandPrimary = '';\nlet pairCommandStart = '';\nlet computerStep = 'intro';\nlet lastConnection = { paired: false, online: false };\nlet promptedForComputer = false;\nlet visibleMessageCount = 20;\nlet lastMessageTotal = 0;\nlet loadingOlderMessages = false;\nlet sendingMessage = false;\nlet shouldStickToBottom = true;\nlet activeConversationId = localStorage.getItem('king:activeConversationId') || 'king-convo';\n\nfunction escapeHtml(value) {\n  return String(value ?? '').replace(/[&<>\"']/g, function(ch) {\n    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' })[ch];\n  });\n}\nfunction formatTime(value) {\n  if (!value) return '未收到';\n  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });\n}\nfunction lifecycleLabel(value) {\n  return ({ 'on-demand': '按需启动', '24/7': '持续在线', idle_cached: '空闲保活', disabled: '停用' })[value] || value || '按需启动';\n}\nfunction taskStatusLabel(value) {\n  return ({ pending: '待分配', assigned: '已分配', in_progress: '进行中', review: '待评审', done: '已完成', failed: '失败', blocked: '被阻塞' })[value] || value || '未知';\n}\nfunction reasonLabel(reason) {\n  return String(reason || '')\n    .replace(/(\\\\\\\\d+) unread message\\\\\\\\(s\\\\\\\\) pending/g, '$1 条消息等待本地 AI 处理')\n    .replace(/(\\\\\\\\d+) failed run\\\\\\\\(s\\\\\\\\)/g, '$1 次运行失败')\n    .replace('no state changes detected', '等待下一条消息。');\n}\nasync function request(path, options) {\n  const res = await fetch(path, options);\n  if (!res.ok) throw new Error(await res.text());\n  return res.headers.get('Content-Type') && res.headers.get('Content-Type').includes('application/json') ? res.json() : res.text();\n}\nfunction openSettings() {\n  document.getElementById('settingsDialog').showModal();\n}\nfunction closeSettings() {\n  document.getElementById('settingsDialog').close();\n}\nfunction closeComputerDialog() {\n  document.getElementById('computerDialog').close();\n}\nasync function openComputerFlow(step) {\n  computerStep = step || 'intro';\n  const settings = document.getElementById('settingsDialog');\n  if (settings.open) settings.close();\n  renderComputerFlow();\n  const dialog = document.getElementById('computerDialog');\n  if (!dialog.open) dialog.showModal();\n  if (!pairCommand) await loadPairCommand();\n}\nasync function loadPairCommand() {\n  const summary = await request('/gui/summary');\n  if (!summary.pairingCode) return;\n  pairCommandPrimary = 'king agent computer --pair ' + summary.pairingCode + ' --server ' + base;\n  pairCommandStart = 'king agent computer --server ' + base;\n  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;\n  lastConnection = summary.connection || lastConnection;\n  if (document.getElementById('computerDialog').open && computerStep === 'connect') renderComputerFlow();\n}\nfunction dismissComputerIntro() {\n  const checkbox = document.getElementById('dontRemindComputer');\n  if (checkbox && checkbox.checked) localStorage.setItem('king:addComputerDismissed', '1');\n  closeComputerDialog();\n}\nfunction renderComputerFlow() {\n  const connected = Boolean(lastConnection.online);\n  const paired = Boolean(lastConnection.paired);\n  const connectionText = connected ? 'Computer connected.' : paired ? 'Computer paired. Waiting for it to come online...' : 'Waiting for computer to connect...';\n  const flow = document.getElementById('computerFlow');\n  if (computerStep === 'select') {\n    flow.innerHTML =\n      '<div class=\"computer-actions\"><button class=\"icon button-shadow\" onclick=\"closeComputerDialog()\" aria-label=\"Close\">×</button></div>' +\n      '<h2 class=\"computer-title\">Add Computer</h2>' +\n      '<div class=\"choice-grid\">' +\n      '<button class=\"computer-choice active\" onclick=\"openComputerFlow(&quot;connect&quot;)\"><span class=\"computer-icon\">▭</span><span><strong class=\"computer-choice-title\">Your Computer</strong><span class=\"computer-muted\">Run agents on your own computer</span></span></button>' +\n      '<button class=\"computer-choice disabled\" type=\"button\"><span class=\"computer-icon\">☁</span><span><strong class=\"computer-choice-title\">Cloud Computer</strong><span class=\"computer-muted\">Coming soon</span></span></button>' +\n      '</div>' +\n      '<div class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"closeComputerDialog()\">Cancel</button><button class=\"primary-pink button-shadow\" onclick=\"openComputerFlow(&quot;connect&quot;)\">Next</button></div>';\n    return;\n  }\n  if (computerStep === 'connect') {\n    flow.innerHTML =\n      '<div class=\"computer-actions\"><button class=\"icon button-shadow\" onclick=\"closeComputerDialog()\" aria-label=\"Close\">×</button></div>' +\n      '<h2 class=\"computer-title\">Connect Computer</h2>' +\n      '<p><strong>&gt;_ Run this command on your computer to connect:</strong></p>' +\n      '<div class=\"connect-row\"><div class=\"connect-stack\">' +\n      '<div class=\"connect-help\">First-time pairing: run this once to attach this browser session.</div>' +\n      '<pre class=\"connect-command\">' + escapeHtml(pairCommandPrimary || 'Loading pairing code...') + '</pre>' +\n      '<div class=\"connect-help\">Already paired: use this later to start the local computer runtime.</div>' +\n      '<pre class=\"connect-command\">' + escapeHtml(pairCommandStart || 'Loading start command...') + '</pre></div><button class=\"icon button-shadow\" onclick=\"copyPairCommand()\" aria-label=\"Copy commands\">□</button></div>' +\n      '<div class=\"connect-status\"><span class=\"status-dot' + (connected ? ' online' : '') + '\"></span><span>' + connectionText + '</span></div>' +\n      '<div class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"closeComputerDialog()\">Cancel</button><button class=\"' + (connected ? 'primary-pink' : 'disabled-action') + ' button-shadow\" onclick=\"' + (connected ? 'closeComputerDialog()' : 'refresh()') + '\">' + (connected ? 'Done' : 'Done') + '</button></div>';\n    return;\n  }\n  flow.innerHTML =\n    '<div><div class=\"computer-kicker\">Meet King</div><h2 class=\"computer-title\">Add a Computer</h2></div>' +\n    '<div class=\"computer-lead\"><span class=\"computer-icon\">▭</span><div><p>Your agents need somewhere to run. Connect a computer and they will come online there.</p><p class=\"computer-muted\">Need an agent runtime installed: Claude Code, Codex CLI, Kimi CLI, Copilot CLI, Cursor CLI, Gemini CLI, OpenCode, or Pi.</p></div></div>' +\n    '<div class=\"computer-rule\"></div>' +\n    '<div class=\"computer-actions between\"><label class=\"check-row\"><input id=\"dontRemindComputer\" type=\"checkbox\" />Do not remind me again</label><span class=\"computer-actions\"><button class=\"button-shadow\" onclick=\"dismissComputerIntro()\">Skip</button><button class=\"primary-pink button-shadow\" onclick=\"openComputerFlow(&quot;select&quot;)\">▭ Add Computer</button></span></div>';\n}\nfunction showPanel(name) {\n  ['chat', 'tasks', 'files'].forEach(function(panel) {\n    document.getElementById('panel-' + panel).classList.toggle('active', panel === name);\n    document.querySelector('[data-panel=\"' + panel + '\"]').classList.toggle('active', panel === name);\n  });\n}\nfunction scrollToBottom() {\n  const workspace = document.querySelector('.workspace');\n  workspace.scrollTop = workspace.scrollHeight;\n  shouldStickToBottom = true;\n  updateBackToBottom();\n}\nfunction updateBackToBottom() {\n  const workspace = document.querySelector('.workspace');\n  const jump = document.querySelector('.jump');\n  const distance = workspace.scrollHeight - workspace.clientHeight - workspace.scrollTop;\n  const away = distance > 180;\n  shouldStickToBottom = !away;\n  jump.classList.toggle('visible', away);\n}\nasync function handleWorkspaceScroll() {\n  updateBackToBottom();\n  const workspace = document.querySelector('.workspace');\n  if (loadingOlderMessages || workspace.scrollTop > 24 || visibleMessageCount >= lastMessageTotal) return;\n  loadingOlderMessages = true;\n  const beforeHeight = workspace.scrollHeight;\n  const beforeTop = workspace.scrollTop;\n  visibleMessageCount = Math.min(visibleMessageCount + 20, lastMessageTotal);\n  await refresh({ preserveScroll: true });\n  workspace.scrollTop = workspace.scrollHeight - beforeHeight + beforeTop;\n  loadingOlderMessages = false;\n}\nasync function copyPairCommand() {\n  if (!pairCommand) return;\n  await navigator.clipboard.writeText(pairCommand).catch(function() {});\n}\nasync function sendMessage() {\n  if (sendingMessage) return;\n  const input = document.getElementById('body');\n  const button = document.getElementById('sendButton');\n  const body = input.value.trim();\n  if (!body) return;\n  sendingMessage = true;\n  input.value = '';\n  input.blur();\n  button.disabled = true;\n  button.textContent = 'Sending';\n  try {\n    await request('/gui/message', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ body, conversationId: activeConversationId })\n    });\n    visibleMessageCount = 20;\n    shouldStickToBottom = true;\n    await refresh();\n  } catch (error) {\n    input.value = body;\n    throw error;\n  } finally {\n    sendingMessage = false;\n    button.disabled = false;\n    button.textContent = 'Send';\n  }\n}\nasync function clearMessages() {\n  await request('/gui/clear-messages', { method: 'POST' });\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  await refresh();\n}\nasync function saveAgentConfig() {\n  await request('/gui/agent-config', {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({\n      name: document.getElementById('agentName').value,\n      role: document.getElementById('agentRole').value,\n      engine: document.getElementById('engine').value,\n      lifecycle: 'on-demand',\n      model: document.getElementById('model').value,\n      fastModel: document.getElementById('fastModel').value\n    })\n  });\n  await refresh();\n}\nfunction renderMessages(state, options) {\n  const allRows = (state.messages || []).filter(function(message) { return message.conversation_id === activeConversationId; });\n  if (allRows.length > lastMessageTotal) visibleMessageCount = 20;\n  lastMessageTotal = allRows.length;\n  visibleMessageCount = Math.min(Math.max(visibleMessageCount, 20), Math.max(lastMessageTotal, 20));\n  const rows = allRows.slice(-visibleMessageCount);\n  const hasOlder = rows.length < allRows.length;\n  const unread = rows.filter(function(message) { return !(message.readBy || []).includes('king-agent') && message.author_kind === 'human'; }).length;\n  const olderLine = hasOlder ? 'Pull down or scroll to top to load older messages...' : 'No older messages';\n  const html = rows.length ? rows.map(function(message) {\n    if (message.author_kind === 'system') {\n      return '<div class=\"system-line\">' + escapeHtml(message.body) + '</div>';\n    }\n    const initial = message.author_kind === 'agent' ? 'A' : '人';\n    const name = message.author_kind === 'agent' ? (message.author_name || 'AI') : (message.author_name || 'you');\n    const unreadClass = message.author_kind === 'human' && !(message.readBy || []).includes('king-agent') ? ' highlight' : '';\n    return '<article class=\"post' + unreadClass + '\"><div class=\"avatar\">' + initial + '</div><div><div class=\"post-top\"><span class=\"author\">' + escapeHtml(name) + '</span><span class=\"time\">' + formatTime(message.created_at) + '</span></div><div class=\"post-body\">' + escapeHtml(message.body) + '</div></div></article>';\n  }).join('') : '';\n  document.getElementById('chatWindow').innerHTML = '<div class=\"system-line\">' + olderLine + '</div>' + html;\n  if (options && options.preserveScroll) updateBackToBottom();\n  else if (shouldStickToBottom) scrollToBottom();\n  else updateBackToBottom();\n}\nfunction selectConversation(id) {\n  activeConversationId = id || 'king-convo';\n  localStorage.setItem('king:activeConversationId', activeConversationId);\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  refresh();\n}\nfunction createConversation() {\n  const input = document.getElementById('newWindowTitle');\n  input.value = '';\n  const dialog = document.getElementById('newWindowDialog');\n  if (!dialog.open) dialog.showModal();\n  setTimeout(function() { input.focus(); }, 0);\n}\nfunction closeNewWindowDialog() {\n  document.getElementById('newWindowDialog').close();\n}\nasync function submitConversation(event) {\n  event.preventDefault();\n  const input = document.getElementById('newWindowTitle');\n  const title = input.value.trim();\n  const submit = document.getElementById('newWindowSubmit');\n  submit.disabled = true;\n  submit.textContent = 'Creating';\n  try {\n    const result = await request('/gui/conversations', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ title })\n    });\n    activeConversationId = result.conversation.id;\n    localStorage.setItem('king:activeConversationId', activeConversationId);\n    visibleMessageCount = 20;\n    shouldStickToBottom = true;\n    closeNewWindowDialog();\n    await refresh();\n  } finally {\n    submit.disabled = false;\n    submit.textContent = 'Create';\n  }\n}\nfunction activeConversationStatus(summary, active) {\n  const state = summary.state || {};\n  const typing = (state.typingLog || []).slice().reverse().find(function(row) { return row.conversationId === active.id && !row.done; });\n  const thinking = (state.thinkingLog || []).slice().reverse().find(function(row) { return row.action === 'mark' && (row.conversationIds || []).includes(active.id); });\n  if (typing) return 'agent 正在输入...';\n  if (thinking) return 'agent 正在处理...';\n  if ((active.unread || 0) > 0) return '等待本地 agent 回复';\n  return 'General channel for all members';\n}\nfunction renderConversations(summary) {\n  const conversations = summary.conversations || [];\n  if (conversations.length && !conversations.some(function(row) { return row.id === activeConversationId; })) activeConversationId = conversations[0].id;\n  const active = conversations.find(function(row) { return row.id === activeConversationId; }) || conversations[0] || { id: 'king-convo', title: 'all' };\n  document.querySelector('.channel-name').textContent = active.title || active.id;\n  document.querySelector('.composer textarea').placeholder = 'Message #' + (active.title || active.id);\n  document.querySelector('.hash').textContent = active.id === 'king-convo' ? '#' : '~';\n  document.getElementById('routeSummary').textContent = activeConversationStatus(summary, active);\n  document.getElementById('conversationList').innerHTML = conversations.map(function(row) {\n    const deletable = row.id !== 'king-convo';\n    return '<div class=\"window-item' + (row.id === activeConversationId ? ' active' : '') + '\"><button class=\"window-select\" onclick=\"selectConversation(&quot;' + escapeHtml(row.id) + '&quot;)\"><span class=\"window-name\">' + escapeHtml(row.title || row.id) + '</span></button><span class=\"window-meta\">' + escapeHtml(row.unread || 0) + '</span>' + (deletable ? '<button class=\"window-delete\" onclick=\"deleteConversation(event, &quot;' + escapeHtml(row.id) + '&quot;)\" aria-label=\"Delete window\">×</button>' : '') + '</div>';\n  }).join('');\n}\nasync function deleteConversation(event, id) {\n  event.stopPropagation();\n  await request('/gui/conversations/' + encodeURIComponent(id) + '/delete', { method: 'POST' });\n  if (activeConversationId === id) {\n    activeConversationId = 'king-convo';\n    localStorage.setItem('king:activeConversationId', activeConversationId);\n  }\n  visibleMessageCount = 20;\n  shouldStickToBottom = true;\n  await refresh();\n}\nfunction renderTasks(state) {\n  const tasks = state.tasks || [];\n  document.getElementById('taskBadge').textContent = String(tasks.filter(function(task) { return task.status !== 'done'; }).length);\n  document.getElementById('panel-tasks').innerHTML = tasks.length ? tasks.slice().reverse().map(function(task) {\n    return '<div class=\"task-row\"><div class=\"task-top\"><h3>' + escapeHtml(task.title) + '</h3><span class=\"time\">' + escapeHtml(taskStatusLabel(task.status)) + ' P' + escapeHtml(task.priority) + '</span></div><p>' + escapeHtml(task.description || ((task.scope && task.scope.paths || []).join(', ')) || 'No description') + '</p></div>';\n  }).join('') : '<p class=\"muted\">No tasks yet.</p>';\n  const artifacts = state.artifacts || [];\n  document.getElementById('panel-files').innerHTML = artifacts.length ? artifacts.slice().reverse().map(function(artifact) {\n    return '<div class=\"task-row\"><div class=\"task-top\"><h3>' + escapeHtml(artifact.path || artifact.name || 'artifact') + '</h3><span class=\"time\">' + escapeHtml(artifact.kind || 'file') + '</span></div><p>' + escapeHtml(artifact.source || artifact.confidence || '') + '</p></div>';\n  }).join('') : '<p class=\"muted\">No files yet.</p>';\n}\nfunction renderSummary(summary) {\n  const connection = summary.connection || {};\n  const observation = summary.observation || { counts: {}, reasons: [] };\n  const counts = observation.counts || {};\n  const agent = summary.agent || {};\n  lastConnection = connection;\n  const heartbeatStat = document.getElementById('heartbeatStat');\n  if (heartbeatStat) heartbeatStat.textContent = '最近心跳：' + (connection.lastHeartbeatAt ? formatTime(connection.lastHeartbeatAt) : '未收到');\n  document.getElementById('unreadStat').textContent = String(counts.unreadMessages || 0);\n  document.getElementById('failedStat').textContent = String(counts.failedRuns || 0);\n  document.getElementById('activityBadge').textContent = String((counts.unreadMessages || 0) + (counts.failedRuns || 0));\n  renderConversations({ ...summary, state: window.__lastState || {} });\n  const observationReasons = document.getElementById('observationReasons');\n  if (observationReasons) observationReasons.textContent = (observation.reasons || []).map(reasonLabel).join('；') || '等待下一条消息。';\n  if (summary.pairingCode) {\n    pairCommandPrimary = 'king agent computer --pair ' + summary.pairingCode + ' --server ' + base;\n  pairCommandStart = 'king agent computer --server ' + base;\n  pairCommand = pairCommandPrimary + '\\n' + pairCommandStart;\n    if (document.getElementById('computerDialog').open) renderComputerFlow();\n  }\n  if (!connection.paired && !promptedForComputer && !localStorage.getItem('king:addComputerDismissed')) {\n    promptedForComputer = true;\n    setTimeout(function() {\n      if (!document.getElementById('settingsDialog').open && !document.getElementById('computerDialog').open) openComputerFlow('intro');\n    }, 250);\n  }\n  const engines = summary.availableEngines || [];\n  document.getElementById('engine').innerHTML = engines.length ? engines.map(function(engine) {\n    return '<option value=\"' + escapeHtml(engine) + '\"' + (engine === agent.engine ? ' selected' : '') + '>' + escapeHtml(engine) + '</option>';\n  }).join('') : '<option value=\"\">请先配对</option>';\n  document.getElementById('agentName').value = agent.name || 'King Agent';\n  document.getElementById('agentRole').value = agent.role || 'Local BYOA agent';\n  document.getElementById('model').value = agent.model === 'default' ? '' : (agent.model || '');\n  document.getElementById('fastModel').value = agent.fastModel === 'default' ? '' : (agent.fastModel || '');\n  const modelRows = ['claude', 'codex'].map(function(engine) {\n    const available = engines.includes(engine);\n    const active = agent.engine === engine;\n    const label = active && !available ? '当前配置，未检测到本机' : available ? '可用' : '未检测到';\n    return '<div class=\"model-row\"><span>' + engine + (active ? ' · 当前' : '') + '</span><span class=\"' + (available ? 'available' : 'unavailable') + '\">' + label + '</span></div>';\n  }).join('');\n  document.getElementById('modelStatus').innerHTML = modelRows + '<div class=\"model-row\"><span>运行模式</span><span>' + lifecycleLabel(agent.lifecycle) + '</span></div>';\n}\nasync function refresh(options) {\n  const results = await Promise.all([\n    request('/gui/summary'),\n    request('/gui/state')\n  ]);\n  window.__lastState = results[1];\n  renderSummary(results[0]);\n  renderMessages(results[1], options || {});\n  renderTasks(results[1]);\n}\nrefresh();\ndocument.querySelector('.workspace').addEventListener('scroll', handleWorkspaceScroll);\nsetInterval(refresh, 3500);\n";


function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) }
  });
}

function isAgentLifecycle(value: unknown): value is AgentLifecycle {
  return value === "on-demand" || value === "24/7" || value === "idle_cached" || value === "disabled";
}

function stateId(env: Bindings): DurableObjectStub {
  return env.GUI_STATE.get(env.GUI_STATE.idFromName("global"));
}

function bearer(c: { req: { header(name: string): string | undefined } }): string {
  const raw = c.req.header("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

const app = new Hono<Env>();
app.use("*", cors());

app.get("/", (c) => c.html(renderPage(styles, clientScript)));
app.get("/favicon.ico", () => new Response(null, { status: 204 }));

app.post("/api/computers/pair", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const stub = stateId(c.env);
  return stub.fetch("https://state/pair", { method: "POST", body: JSON.stringify(body) });
});

app.get("/api/computers/me/agents", async (c) => {
  const stub = stateId(c.env);
  return stub.fetch("https://state/agents", { headers: { Authorization: c.req.header("Authorization") || "" } });
});

app.post("/api/computers/heartbeat", async (c) => stateId(c.env).fetch("https://state/heartbeat", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));

app.post("/api/agents/:agentId/runtime-token", async (c) => {
  const stub = stateId(c.env);
  return stub.fetch(`https://state/runtime-token/${c.req.param("agentId")}`, {
    method: "POST",
    headers: { Authorization: c.req.header("Authorization") || "" }
  });
});

app.get("/runtime/wake-stream", async (c) => stateId(c.env).fetch("https://state/wake-stream", {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.get("/runtime/inbox", async (c) => stateId(c.env).fetch("https://state/inbox", {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.get("/runtime/inbox-triage/payload", async (c) => stateId(c.env).fetch("https://state/triage", {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.get("/runtime/agenda", async (c) => stateId(c.env).fetch("https://state/agenda", {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.get("/runtime/roster", async (c) => stateId(c.env).fetch("https://state/roster", {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.get("/runtime/preamble", async (c) => stateId(c.env).fetch(`https://state/preamble?${new URL(c.req.url).searchParams.toString()}`, {
  headers: { Authorization: c.req.header("Authorization") || "" }
}));

app.post("/runtime/cli", async (c) => stateId(c.env).fetch("https://state/cli", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json())
}));

app.post("/runtime/status", async (c) => stateId(c.env).fetch("https://state/status", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/typing", async (c) => stateId(c.env).fetch("https://state/typing", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/thinking/mark", async (c) => stateId(c.env).fetch("https://state/thinking/mark", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/thinking/unmark", async (c) => stateId(c.env).fetch("https://state/thinking/unmark", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/events", async (c) => stateId(c.env).fetch("https://state/events", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/notices", async (c) => stateId(c.env).fetch("https://state/notices", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/triage", async (c) => stateId(c.env).fetch("https://state/triage-log", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/runs", async (c) => stateId(c.env).fetch("https://state/runs", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/runs/:runId/heartbeat", (c) => stateId(c.env).fetch(`https://state/runs/${c.req.param("runId")}/heartbeat`, {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "" }
}));
app.post("/runtime/runs/:runId/finish", async (c) => stateId(c.env).fetch(`https://state/runs/${c.req.param("runId")}/finish`, {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/runtime/conversation/mark-read", async (c) => stateId(c.env).fetch("https://state/mark-read", {
  method: "POST",
  headers: { Authorization: c.req.header("Authorization") || "", "Content-Type": "application/json" },
  body: JSON.stringify(await c.req.json())
}));

app.get("/gui/state", (c) => stateId(c.env).fetch("https://state/gui-state"));
app.get("/gui/summary", (c) => stateId(c.env).fetch("https://state/gui-summary"));
app.get("/gui/activity", (c) => stateId(c.env).fetch(`https://state/gui-activity?${new URL(c.req.url).searchParams.toString()}`));
app.get("/gui/export-state", (c) => stateId(c.env).fetch("https://state/gui-export-state"));
app.post("/gui/import-state", async (c) => stateId(c.env).fetch("https://state/gui-import-state", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => null))
}));
app.post("/gui/reset-state", (c) => stateId(c.env).fetch("https://state/gui-reset-state", { method: "POST" }));
app.post("/gui/message", async (c) => stateId(c.env).fetch("https://state/gui-message", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/conversations", async (c) => stateId(c.env).fetch("https://state/gui-conversations", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/conversations/:conversationId/delete", (c) => stateId(c.env).fetch(`https://state/gui-conversations/${c.req.param("conversationId")}/delete`, { method: "POST" }));
app.post("/gui/clear-messages", async (c) => stateId(c.env).fetch("https://state/gui-clear-messages", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/agent-config", async (c) => stateId(c.env).fetch("https://state/gui-agent-config", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/card", async (c) => stateId(c.env).fetch("https://state/gui-card", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/task", async (c) => stateId(c.env).fetch("https://state/gui-task", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/task/:taskId/update", async (c) => stateId(c.env).fetch(`https://state/gui-task/${c.req.param("taskId")}/update`, {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/card/:cardId/move", async (c) => stateId(c.env).fetch(`https://state/gui-card/${c.req.param("cardId")}/move`, {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/conversation/mark-read", async (c) => stateId(c.env).fetch("https://state/gui-conversation/mark-read", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));
app.post("/gui/wake", async (c) => stateId(c.env).fetch("https://state/gui-wake", {
  method: "POST",
  body: JSON.stringify(await c.req.json().catch(() => ({})))
}));

export class GuiState implements DurableObject {
  private waiters = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/pair") return this.pair(await request.json().catch(() => ({})) as PairPayload);
    if (path === "/agents") return this.authDevice(request, async () => json((await this.get()).agents));
    if (path === "/heartbeat") return this.authDevice(request, async () => this.heartbeat(await request.json().catch(() => ({}))));
    if (path.startsWith("/runtime-token/")) return this.authDevice(request, async () => json({ token: (await this.get()).runtimeToken, expiresInSeconds: 3600 }));
    if (path === "/wake-stream") return this.authRuntime(request, async () => this.wakeStream());
    if (path === "/inbox") return this.authRuntime(request, async () => this.inbox());
    if (path === "/triage") return this.authRuntime(request, async () => this.triage());
    if (path === "/agenda") return this.authRuntime(request, async () => this.agenda());
    if (path === "/roster") return this.authRuntime(request, async () => this.roster());
    if (path === "/preamble") return this.authRuntime(request, async () => this.preamble(url.searchParams));
    if (path === "/cli") return this.authRuntime(request, async () => this.cli(await request.json() as { argv?: string[]; agentId?: string }));
    if (path === "/mark-read") return this.authRuntime(request, async () => this.markRead(await request.json() as { conversationId?: string; upToMessageId?: string }));
    if (path === "/status") return this.authRuntime(request, async () => this.status(await request.json() as { status?: string }));
    if (path === "/typing") return this.authRuntime(request, async () => this.typing(await request.json() as { conversationId?: string; done?: boolean }));
    if (path === "/thinking/mark") return this.authRuntime(request, async () => this.thinking("mark", await request.json() as { conversationIds?: string[] }));
    if (path === "/thinking/unmark") return this.authRuntime(request, async () => this.thinking("unmark", await request.json() as { conversationIds?: string[] }));
    if (path === "/events") return this.authRuntime(request, async () => this.events(await request.json().catch(() => null)));
    if (path === "/notices") return this.authRuntime(request, async () => this.logBody("noticeLog", await request.json().catch(() => null)));
    if (path === "/triage-log") return this.authRuntime(request, async () => this.logBody("triageLog", await request.json().catch(() => null)));
    if (path === "/runs") return this.authRuntime(request, async () => this.startRun(await request.json().catch(() => null)));
    if (path.startsWith("/runs/") && path.endsWith("/heartbeat")) return this.authRuntime(request, async () => this.runAction(path.split("/")[2] || "run", "heartbeat"));
    if (path.startsWith("/runs/") && path.endsWith("/finish")) return this.authRuntime(request, async () => this.runAction(path.split("/")[2] || "run", "finish", await request.json().catch(() => null)));
    if (path === "/gui-state") return json(await this.get());
    if (path === "/gui-summary") return this.guiSummary();
    if (path === "/gui-activity") return this.guiActivity(url.searchParams);
    if (path === "/gui-export-state") return json(this.snapshot(await this.get()));
    if (path === "/gui-import-state") return this.importSnapshot(await request.json().catch(() => null));
    if (path === "/gui-reset-state") return this.resetState();
    if (path === "/gui-message") return this.guiMessage(await request.json() as { body?: string; conversationId?: string });
    if (path === "/gui-conversations") return this.guiConversation(await request.json().catch(() => ({})) as { title?: unknown });
    if (path.startsWith("/gui-conversations/") && path.endsWith("/delete")) return this.guiDeleteConversation(path.split("/")[2]);
    if (path === "/gui-clear-messages") return this.clearMessages(await request.json().catch(() => ({})) as { conversationId?: string });
    if (path === "/gui-agent-config") return this.agentConfig(await request.json() as AgentConfigPayload);
    if (path === "/gui-card") return this.createCard(await request.json().catch(() => ({})) as { title?: string; assignee?: string; allowedPaths?: string[] });
    if (path === "/gui-task") return this.createTask(await request.json().catch(() => ({})) as GuiTaskPayload);
    if (path.startsWith("/gui-task/") && path.endsWith("/update")) return this.updateTask(path.split("/")[2], await request.json().catch(() => ({})) as GuiTaskUpdatePayload);
    if (path.startsWith("/gui-card/") && path.endsWith("/move")) return this.moveCard(path.split("/")[2], await request.json().catch(() => ({})) as GuiCardMovePayload);
    if (path === "/gui-conversation/mark-read") return this.guiMarkRead(await request.json().catch(() => ({})) as { conversationId?: string; upToMessageId?: string });
    if (path === "/gui-wake") return this.guiWake(await request.json().catch(() => ({})));
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
      pairingCode: crypto.randomUUID(),
      availableEngines: [],
      capabilities: { workspaces: [] },
      agents: [DEFAULT_AGENT],
      conversations: [{ ...DEFAULT_CONVERSATION, created_at: Date.now(), updated_at: Date.now() }],
      messages: [],
      cliLog: [],
      statusLog: [],
      typingLog: [],
      thinkingLog: [],
      eventLog: [],
      eventRoutes: [],
      loopRunId: "run-gui",
      currentLoop: 0,
      loopEvents: [],
      noticeLog: [],
      triageLog: [],
      runLog: [],
      initiatives: [],
      tasks: [],
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
      approvals: []
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
    saved.agents = Array.isArray(saved.agents) && saved.agents.length ? saved.agents : [DEFAULT_AGENT];
    saved.conversations = normalizeConversations(saved.conversations, saved.messages ?? []);
    saved.messages ??= [];
    saved.cliLog ??= [];
    saved.statusLog ??= [];
    saved.typingLog ??= [];
    saved.thinkingLog ??= [];
    saved.eventLog ??= [];
    saved.noticeLog ??= [];
    saved.triageLog ??= [];
    saved.runLog ??= [];
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

  private async pair(payload?: PairPayload): Promise<Response> {
    const state = await this.get();
    if (typeof payload?.code !== "string" || payload.code !== state.pairingCode) {
      return json({ error: "invalid pairing code" }, { status: 401 });
    }
    state.availableEngines = Array.isArray(payload?.engines) ? payload.engines.filter((engine): engine is string => typeof engine === "string") : [];
    state.capabilities = normalizeCapabilities(payload?.capabilities);
    await this.put(state);
    return json({ computerId: state.computerId, deviceToken: state.deviceToken });
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

  private async guiSummary(): Promise<Response> {
    const state = await this.get();
    const agent = state.agents[0] ?? DEFAULT_AGENT;
    const agentSummary = agentStateSummary(state, agent);
    const observation = buildLoopSnapshot(state);
    const lastRunStart = state.runLog.slice().reverse().find((row) => row.action === "start");
    const lastRunFinish = state.runLog.slice().reverse().find((row) => row.action === "finish");
    const lastHeartbeatAt = state.lastHeartbeat?.at;
    const paired = state.availableEngines.length > 0;
    const online = Boolean(lastHeartbeatAt && Date.now() - lastHeartbeatAt < 90_000);
    const unread = unreadMessagesFor(state, DEFAULT_AGENT.id);
    return json({
      connection: {
        paired,
        online,
        computerId: state.computerId,
        lastHeartbeatAt,
        version: state.lastHeartbeat?.version
      },
      pairingCode: state.pairingCode,
      conversations: conversationSummaries(state),
      availableEngines: state.availableEngines,
      capabilities: state.capabilities,
      agent: agentSummary,
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

  private async authRuntime(request: Request, fn: () => Promise<Response>): Promise<Response> {
    const state = await this.get();
    if (token(request) !== state.runtimeToken) return json({ error: "invalid runtime token" }, { status: 401 });
    return fn();
  }

  private async wakeStream(): Promise<Response> {
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

  private async inbox(): Promise<Response> {
    const state = await this.get();
    const unread = unreadMessagesFor(state, DEFAULT_AGENT.id);
    return json({
      rows: sortRuntimeMessages(unread, DEFAULT_AGENT.id).map((item) => item.row),
      routeSummary: formatMessageRouteSummary(unread, DEFAULT_AGENT.id)
    });
  }

  private async triage(): Promise<Response> {
    const state = await this.get();
    const unread = unreadMessagesFor(state, DEFAULT_AGENT.id);
    const routed = sortRuntimeMessages(unread, DEFAULT_AGENT.id);
    const top = routed[0];
    return json({
      instructions: "Return strict JSON: {\"actionable\": boolean, \"reason\": string, \"promptNote\": string, \"routeHint\": \"ignore|monitor|respond|steer\", \"priority\": \"normal|steer|urgent\"}. Mark human messages actionable and prioritize blocker, approval, decision, direct, and @mention messages.",
      input: routed.map((item) => `${messageRouteTag(item)} score=${item.score} ${item.row.author_name}: ${item.row.body}`).join("\n"),
      routeSummary: formatMessageRouteSummary(unread, DEFAULT_AGENT.id),
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

  private async agenda(): Promise<Response> {
    const state = await this.get();
    const now = new Date();
    const due = state.calendar.filter((item) =>
      item.assignee === DEFAULT_AGENT.id &&
      (Date.parse(item.at) <= now.getTime() || (item.cron ? cronMatches(item.cron, now) : false))
    );
    const card = state.cards.find((row) => row.column !== "done" && (!row.assignee || row.assignee === DEFAULT_AGENT.id));
    const task = state.tasks.find((row) => taskVisibleStatus(state, row) !== "done" && taskVisibleStatus(state, row) !== "blocked" && (!row.assignee || row.assignee === DEFAULT_AGENT.id));
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

  private async cli(payload: { argv?: string[]; agentId?: string; engine?: string }): Promise<Response> {
    const argv = payload.argv ?? [];
    const state = await this.get();
    const actor = state.agents.find((agent) => agent.id === payload.agentId) ?? DEFAULT_AGENT;
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
        message.status === "pending"
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
        readBy: [DEFAULT_AGENT.id]
      };
      if (pending) {
        Object.assign(pending, {
          author_name: reply.author_name,
          author_engine: reply.author_engine,
          status: reply.status,
          body: reply.body,
          quoted_message_id: reply.quoted_message_id,
          created_at: reply.created_at,
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
      result = JSON.stringify(unreadMessagesFor(state, DEFAULT_AGENT.id), null, 2);
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
      const rows = [
        ...state.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: "agent",
          role: agent.role,
          engine: agent.engine ?? "auto"
        })),
        { id: "gui-human", name: "King Human", kind: "human", role: "Runtime operator", engine: undefined }
      ];
      const filtered = query
        ? rows.filter((row) => [row.id, row.name, row.kind, row.role, row.engine].filter(Boolean).join(" ").toLowerCase().includes(query))
        : rows;
      result = filtered.map((row) => `${row.id}\t${row.name}\t${row.kind}\t${row.role}${row.engine ? `\t${row.engine}` : ""}`).join("\n");
    } else if (argv[0] === "whoami") {
      result = JSON.stringify(agentStateSummary(state, state.agents[0] ?? DEFAULT_AGENT), null, 2);
    } else if (argv[0] === "status") {
      result = JSON.stringify({
        agent: state.agents[0],
        agentState: agentStateSummary(state, state.agents[0] ?? DEFAULT_AGENT),
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
      result = this.taskCommand(state, argv.slice(1));
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
      result = JSON.stringify((await this.agenda().then((res) => res.json())) as AgendaPayload, null, 2);
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
    if (cmd === "spawn") return "agent spawn is not supported by this single-agent gui runtime";
    if (cmd === "destroy") return "agent destroy is not supported by this single-agent gui runtime";
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

  private taskCommand(state: State, args: string[]): string {
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
      const task = findTask(state, args[1]);
      return task ? JSON.stringify(task, null, 2) : `task not found: ${args[1] || ""}`;
    }
    if (cmd === "create") {
      const title = stripOptions(args.slice(1), ["--assign", "--assignee", "--priority", "--parent", "--after", "--path", "--pattern", "--desc", "--initiative", "--capsule", "--subsystem", "--profile"]).join(" ").trim();
      if (!title) return "usage: king task create <title> [--assign agent-id] [--priority 1-10] [--after id1,id2] [--path a,b] [--pattern a,b] [--desc text]";
      const now = Date.now();
      const task: Task = {
        id: `task-${now}-${Math.random().toString(36).slice(2)}`,
        title,
        description: readOption(args, "--desc"),
        status: readOption(args, "--assign") || readOption(args, "--assignee") ? "assigned" : "pending",
        assignee: readOption(args, "--assign") || readOption(args, "--assignee"),
        priority: normalizePriority(readOption(args, "--priority")),
        parentId: readOption(args, "--parent"),
        dependsOn: parseCsvOption(args, "--after"),
        initiativeId: readOption(args, "--initiative"),
        capsuleId: readOption(args, "--capsule"),
        subsystem: readOption(args, "--subsystem"),
        scope: taskScopeFromArgs(args),
        executionProfile: readOption(args, "--profile"),
        created_at: now,
        updated_at: now
      };
      state.tasks.push(task);
      return `Task ${task.id} created: "${task.title}" [${task.status}]`;
    }
    if (cmd === "update") {
      const task = findTask(state, args[1]);
      if (!task) return `task not found: ${args[1] || ""}`;
      const status = readOption(args, "--status");
      if (status && !isTaskStatus(status)) return `invalid task status: ${status}`;
      const nextStatus: TaskStatus = status && isTaskStatus(status) ? status : task.status;
      const previousStatus = task.status;
      task.status = nextStatus;
      task.assignee = readOption(args, "--assign") || readOption(args, "--assignee") || task.assignee;
      task.result = readOption(args, "--result") ?? task.result;
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
      const task = findTask(state, args[1]);
      if (!task) return `task not found: ${args[1] || ""}`;
      const previousStatus = task.status;
      task.status = "done";
      task.result = args.slice(2).join(" ").trim() || task.result;
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
      return `Task ${task.id} marked done.`;
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
        const task = findTask(state, request.taskId);
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
      const request: ApprovalRequest = {
        id: `approval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        action,
        context: parseSafetyContext(args),
        status: "pending",
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

  private async status(payload: { status?: string }): Promise<Response> {
    const state = await this.get();
    state.statusLog.push({ at: Date.now(), status: payload.status || "unknown" });
    await this.put(state);
    return json({ ok: true });
  }

  private async typing(payload: { conversationId?: string; done?: boolean }): Promise<Response> {
    const state = await this.get();
    state.typingLog.push({ at: Date.now(), conversationId: payload.conversationId, done: payload.done });
    await this.put(state);
    return json({ ok: true });
  }

  private async thinking(action: "mark" | "unmark", payload: { conversationIds?: string[] }): Promise<Response> {
    const state = await this.get();
    const now = Date.now();
    const ids = Array.isArray(payload.conversationIds) ? payload.conversationIds.filter((id): id is string => typeof id === "string") : [];
    state.thinkingLog.push({
      at: now,
      action,
      conversationIds: ids
    });
    state.composing = state.composing.filter((claim) => claim.expires_at > now && !(ids.includes(claim.conversationId) && claim.agentId === DEFAULT_AGENT.id));
    if (action === "mark") {
      for (const conversationId of ids) {
        state.composing.push({
          conversationId,
          agentId: DEFAULT_AGENT.id,
          agentName: DEFAULT_AGENT.name,
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
    state.runLog.push({ at: Date.now(), runId, action: "start", body });
    await this.put(state);
    return json({ runId });
  }

  private async runAction(runId: string, action: "heartbeat" | "finish", body?: unknown): Promise<Response> {
    const state = await this.get();
    state.runLog.push({ at: Date.now(), runId, action, body });
    await this.put(state);
    return json({ ok: true, runId });
  }

  private async markRead(payload: { conversationId?: string; upToMessageId?: string }): Promise<Response> {
    const state = await this.get();
    const conversationMessages = state.messages.filter((m) => m.conversation_id === payload.conversationId);
    const cutoffIndex = conversationMessages.findIndex((m) => m.id === payload.upToMessageId);
    const readable = cutoffIndex >= 0 ? conversationMessages.slice(0, cutoffIndex + 1) : conversationMessages;
    for (const message of readable) {
      if (
        !message.readBy.includes(DEFAULT_AGENT.id)
      ) {
        message.readBy.push(DEFAULT_AGENT.id);
      }
    }
    await this.put(state);
    return json({ ok: true });
  }

  private async guiConversation(payload: { title?: unknown }): Promise<Response> {
    const state = await this.get();
    const now = Date.now();
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : `事务 ${state.conversations.length + 1}`;
    const maxOrder = Math.max(0, ...state.conversations.map((conversation) => conversation.order ?? 0));
    const order = Math.max(maxOrder + 1, now * 1000);
    const conversation: Conversation = {
      id: `convo-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      kind: "group",
      created_at: now,
      updated_at: now,
      order
    };
    state.conversations.push(conversation);
    await this.put(state);
    return json({ ok: true, conversation });
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

  private async guiMessage(payload: { body?: string; conversationId?: string }): Promise<Response> {
    const state = await this.get();
    const conversation = ensureConversation(state, payload.conversationId || DEFAULT_CONVERSATION.id);
    const now = Date.now();
    const message: Message = {
      id: `msg-${now}`,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      conversation_kind: conversation.kind,
      author_name: "King Human",
      author_kind: "human",
      kind: "message",
      body: payload.body || "Hello from the local gui runtime.",
      created_at: now,
      readBy: []
    };
    const pendingReply: Message = {
      id: `msg-${now}-pending`,
      conversation_id: conversation.id,
      conversation_title: conversation.title,
      conversation_kind: conversation.kind,
      author_name: state.agents[0]?.name || DEFAULT_AGENT.name,
      author_kind: "agent",
      author_engine: state.agents[0]?.engine || DEFAULT_AGENT.engine,
      status: "pending",
      kind: "message",
      body: "AI 正在处理...",
      created_at: now + 1,
      readBy: [DEFAULT_AGENT.id]
    };
    state.messages = state.messages.filter((row) => !(row.conversation_id === conversation.id && row.status === "pending"));
    conversation.updated_at = now;
    state.messages.push(message);
    state.messages.push(pendingReply);
    await this.put(state);
    this.broadcast({ event: "wake", data: { conversationId: message.conversation_id, at: now } });
    return json({ ok: true, message });
  }

  private async guiWake(payload: unknown): Promise<Response> {
    await this.broadcast({ event: "wake", data: { ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : {}), at: Date.now() } });
    return json({ ok: true });
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
    const assignee = typeof payload.assignee === "string" && payload.assignee.trim() ? payload.assignee.trim() : DEFAULT_AGENT.id;
    const priority = typeof payload.priority === "number"
      ? Math.min(10, Math.max(1, Math.round(payload.priority)))
      : 5;
    const paths = normalizeStringList(payload.paths);
    const now = Date.now();
    const task: Task = {
      id: `task-${now}-${Math.random().toString(36).slice(2)}`,
      title,
      description,
      status: assignee ? "assigned" : "pending",
      assignee,
      priority,
      scope: paths.length ? { paths } : undefined,
      created_at: now,
      updated_at: now
    };
    state.tasks.push(task);
    pushLoopEvent(state, {
      type: "queue.backlog",
      agent: assignee,
      taskId: task.id,
      pendingMessages: unreadMessagesFor(state, assignee).length,
      payload: { taskId: task.id, source: "gui-ui" }
    });
    await this.put(state);
    if (payload.wake !== false) await this.broadcast({ event: "wake", data: { agenda: true, taskId: task.id, at: Date.now() } });
    return json({ ok: true, task });
  }

  private async updateTask(taskId: string | undefined, payload: GuiTaskUpdatePayload): Promise<Response> {
    const state = await this.get();
    const task = findTask(state, taskId);
    if (!task) return json({ error: `task not found: ${taskId || ""}` }, { status: 404 });
    const previousStatus = task.status;
    if (typeof payload.status === "string") {
      if (!isTaskStatus(payload.status)) return json({ error: `invalid task status: ${payload.status}` }, { status: 400 });
      task.status = payload.status;
    }
    if (typeof payload.assignee === "string" && payload.assignee.trim()) task.assignee = payload.assignee.trim();
    if (typeof payload.result === "string") task.result = payload.result.trim() || undefined;
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
    await this.put(state);
    await this.broadcast({ event: "wake", data: { agenda: true, taskId: task.id, at: Date.now() } });
    return json({ ok: true, task });
  }

  private newAgentMessage(args: {
    target: string;
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
      conversation_id: `dm-${args.fromName.toLowerCase().replace(/\s+/g, "-")}-${args.target}`,
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
    const previous = state.agents[0] ?? DEFAULT_AGENT;
    const engine = typeof payload.engine === "string" && state.availableEngines.includes(payload.engine) ? payload.engine : state.agents[0]?.engine;
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const role = typeof payload.role === "string" ? payload.role.trim() : "";
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    const fastModel = typeof payload.fastModel === "string" ? payload.fastModel.trim() : "";
    const lifecycle = isAgentLifecycle(payload.lifecycle)
      ? payload.lifecycle
      : state.agents[0]?.lifecycle ?? DEFAULT_AGENT.lifecycle;
    const nextAgent = {
      ...DEFAULT_AGENT,
      ...previous,
      name: name || state.agents[0]?.name || DEFAULT_AGENT.name,
      role: role || state.agents[0]?.role || DEFAULT_AGENT.role,
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
    state.agents = [nextAgent];
    state.agentConfigUpdatedAt = Date.now();
    if (changed) state.runtimeToken = crypto.randomUUID();
    await this.put(state);
    return json({ ok: true, agent: state.agents[0] });
  }

  private async broadcast(evt: { event: string; data: unknown }): Promise<void> {
    const frame = encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`);
    await Promise.all([...this.waiters].map(async (writer) => {
      try {
        await Promise.race([
          writer.write(frame),
          new Promise((_, reject) => setTimeout(() => reject(new Error("sse write timeout")), 1000))
        ]);
      } catch {
        this.waiters.delete(writer);
      }
    }));
  }
}

function token(request: Request): string {
  const raw = request.headers.get("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
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
        order: typeof row.order === "number" ? row.order : undefined
      });
    }
  }
  byId.set(DEFAULT_CONVERSATION.id, {
    ...DEFAULT_CONVERSATION,
    ...byId.get(DEFAULT_CONVERSATION.id),
    title: byId.get(DEFAULT_CONVERSATION.id)?.title || DEFAULT_CONVERSATION.title,
    created_at: byId.get(DEFAULT_CONVERSATION.id)?.created_at || now,
    updated_at: byId.get(DEFAULT_CONVERSATION.id)?.updated_at || now
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
      updated_at: message.created_at
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
    updated_at: now
  };
  state.conversations.push(conversation);
  return conversation;
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
  return state.messages.filter((message) => isRuntimeVisibleMessage(message) && !message.readBy.includes(agentId));
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
  const latestStatus = state.statusLog.at(-1);
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

function findTask(state: State, id: string | undefined): Task | undefined {
  if (!id) return undefined;
  return state.tasks.find((task) => task.id === id || task.id.startsWith(id));
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
    source === "king-agent" ||
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
  return null;
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
