import type { RuntimeAttachment } from "@suwujs/king-ai/attachments";
import type { RunStreamState } from "@suwujs/king-ai/run-stream";

export type Bindings = {
  GUI_STATE: DurableObjectNamespace;
  AUTH_DB?: D1Database;
  BETTER_AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BETTER_AUTH_URL?: string;
  KING_AI_TEST_AUTH_USER?: string;
  KING_AI_HOST_URL?: string;
  KING_AI_HOST_OUTPUT_DIR?: string;
};

export type Env = {
  Bindings: Bindings;
};

export type AuthUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type RequestContext = {
  env: Bindings;
  req: {
    raw: Request;
    header(name: string): string | undefined;
    url: string;
  };
};

export type Agent = {
  id: string;
  name: string;
  role: string;
  engine?: "claude" | "codex";
  lifecycle?: "on-demand" | "24/7" | "idle_cached" | "disabled";
  model?: string;
  fastModel?: string;
  events?: string[];
};

export type AgentLifecycle = NonNullable<Agent["lifecycle"]>;

export type AgentStateSummary = {
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

export type Message = {
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

export type UploadedAttachment = {
  id: string;
  token: string;
  name: string;
  mime: string;
  size: number;
  bytesBase64?: string;
  chunkCount?: number;
  createdAt: number;
};

export type Conversation = {
  id: string;
  title: string;
  kind: "direct" | "group";
  created_at: number;
  updated_at: number;
  order?: number;
  workflowId?: string;
  teamMode?: "single" | "team" | "custom";
  coordinatorAgentId?: string;
  teamAgentIds?: string[];
  teamSnapshot?: ConversationTeamSnapshot;
};

export type ConversationAgentSnapshot = Agent;

export type ConversationTeamSnapshot = {
  workflowId: string;
  mode: NonNullable<Conversation["teamMode"]>;
  coordinatorAgentId: string;
  teamAgentIds: string[];
  agents: ConversationAgentSnapshot[];
  createdAt: number;
};

export type EventRoute = {
  eventType: string;
  agentId: string;
  createdAt: number;
};

export type ExternalEvent = {
  type: string;
  source: string;
  payload: unknown;
  timestamp: number;
};

export type Card = {
  id: string;
  title: string;
  column: "todo" | "doing" | "done";
  assignee?: string;
  claimedBy?: string;
  allowedPaths?: string[];
  created_at: number;
};

export type TaskStatus = "pending" | "assigned" | "in_progress" | "review" | "done" | "failed" | "blocked";
export type TaskReviewResult = "approved" | "changes_requested";
export type TaskEventType = "assigned" | "submitted_for_review" | "completed" | "changes_requested";
export type CapsuleStatus = "open" | "in_review" | "merged" | "abandoned";
export type CapsuleScopeType = "code" | "docs" | "tests" | "ops" | "mixed";
export type MergeStatus = "queued" | "testing" | "merged" | "conflict" | "failed";

export type Task = {
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

export type TaskEvent = {
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

export type InitiativeStatus = "active" | "paused" | "completed" | "abandoned";

export type Initiative = {
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

export type ChangeCapsule = {
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

export type MergeRequest = {
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

export type EvaluationCriteria = {
  name: string;
  weight: number;
  description?: string;
};

export type EvaluationScore = {
  optionId: string;
  scores: Record<string, number>;
  totalScore: number;
  reasoning: string;
};

export type EvaluationRecord = {
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

export type RunFeedback = {
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

export type RunContract = {
  agentId?: string;
  conversationId?: string;
  requestId?: string;
  messageId?: string;
  taskId?: string;
};

export type RunAction = {
  runId: string;
  agentId: string;
  kind: "reply" | "task" | "ignore";
  conversationId?: string;
  requestId?: string;
  messageId?: string;
  taskId?: string;
  summary?: string;
  at: number;
};

export type RuntimeTokenMeta = {
  token: string;
  expiresAt: number;
};

export type ReviewDecision = "approved" | "changes_requested";

export type ReviewRecord = {
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

export type CalendarItem = {
  id: string;
  title: string;
  at: string;
  cron?: string;
  assignee?: string;
  prompt?: string;
  created_at: number;
};

export type Claim = {
  id: string;
  name: string;
  conversationId?: string;
  owner: string;
  allowedPaths?: string[];
  created_at: number;
};

export type Doc = {
  id: string;
  title: string;
  body: string;
  created_at: number;
};

export type Artifact = {
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

export type ArtifactQualityCheck = {
  valid: boolean;
  warnings: string[];
  score: number;
};

export type ContextEntry = {
  key: string;
  value: string;
  updatedBy: string;
  updatedAt: number;
};

export type HypothesisStatus = "proposed" | "active" | "validated" | "rejected" | "abandoned";

export type Hypothesis = {
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

export type Reaction = {
  messageId: string;
  emoji: string;
  authorId: string;
  created_at: number;
};

export type ComposingClaim = {
  conversationId: string;
  agentId: string;
  agentName: string;
  claimed_at: number;
  expires_at: number;
};

export type LoopClassification = "productive" | "idle" | "blocked" | "backlog_stuck" | "error";

export type LoopEventType =
  | "loop.tick"
  | "loop.classified"
  | "agent.spawned"
  | "task.transition"
  | "task.blocked"
  | "queue.backlog"
  | "artifact.created"
  | "agent.budget_exceeded";

export type LoopEvent = {
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

export type LoopSnapshot = {
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

export type SafetyAction =
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

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRequest = {
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

export type RemoteAssistGrant = {
  tokenHash: string;
  tokenPreview: string;
  createdAt: number;
  createdBy?: string;
  revokedAt?: number;
  lastUsedAt?: number;
  uses?: number;
};

export type PlannedTask = {
  title: string;
  description: string;
  scope: { paths: string[]; patterns?: string[] };
  dependencies: string[];
  estimatedTokens: number;
  priority: number;
};

export type ExecutionPlan = {
  optionId: string;
  tasks: PlannedTask[];
  totalEstimatedTokens: number;
};

export type State = {
  computerId: string;
  deviceToken: string;
  runtimeToken: string;
  runtimeTokens?: Record<string, string>;
  runtimeTokenMeta?: Record<string, RuntimeTokenMeta>;
  pairingCode: string;
  availableEngines: string[];
  capabilities: { workspaces: string[]; agentWorkspaceRoot?: string };
  lastHeartbeat?: { at: number; version?: string; capabilities?: { workspaces: string[]; agentWorkspaceRoot?: string } };
  agentConfigUpdatedAt?: number;
  agents: Agent[];
  workflowAgentIds?: Record<string, string[]>;
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
  activeRunContracts?: Record<string, RunContract>;
  runActions?: Record<string, RunAction[]>;
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

export type StateSnapshot = {
  schema: "king-ai.gui-state.v1";
  exportedAt: number;
  state: State;
};

export type EntityStateKey =
  | "conversations"
  | "messages"
  | "cliLog"
  | "statusLog"
  | "typingLog"
  | "thinkingLog"
  | "eventLog"
  | "wakeLog"
  | "eventRoutes"
  | "loopEvents"
  | "noticeLog"
  | "triageLog"
  | "runLog"
  | "runStreams"
  | "activeRunContracts"
  | "runActions"
  | "initiatives"
  | "tasks"
  | "taskEvents"
  | "capsules"
  | "mergeQueue"
  | "evaluations"
  | "runFeedback"
  | "reviews"
  | "cards"
  | "calendar"
  | "claims"
  | "docs"
  | "artifacts"
  | "context"
  | "hypotheses"
  | "reactions"
  | "composing"
  | "approvals"
  | "uploads";
export type EntityState = Pick<State, EntityStateKey>;

export type PairPayload = {
  code?: unknown;
  engines?: unknown;
  capabilities?: unknown;
};

export type AgentConfigPayload = {
  name?: unknown;
  role?: unknown;
  engine?: unknown;
  model?: unknown;
  fastModel?: unknown;
  lifecycle?: unknown;
};

export type GuiTaskPayload = {
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

export type GuiTaskUpdatePayload = {
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

export type GuiConversationPayload = {
  title?: unknown;
  workflowId?: unknown;
  teamMode?: unknown;
  coordinatorAgentId?: unknown;
  teamAgentIds?: unknown;
  agentRoles?: unknown;
};

export type GuiWorkflowAgentsPayload = {
  agentIds?: unknown;
  agents?: unknown;
};

export type GuiCardMovePayload = {
  column?: unknown;
  owner?: unknown;
};

export type AgendaPayload = {
  actionable?: boolean;
  brief?: string;
  focus?: string;
};

export const DEFAULT_AGENT: Agent = {
  id: "king-ai-ceo",
  name: "King AI CEO",
  role: "Coordinate the conversation: clarify ambiguous human requests, split work into concrete tasks for available teammates, track progress, and summarize verified results back to the human. Role template: planner.",
  engine: "codex",
  lifecycle: "on-demand"
};

// Concrete software-dev roster. There is intentionally no standalone `summarizer` agent:
// the `summarizer` role template (team-workflow.ts) stays the capability/permission
// definition for loop-closing, but in this roster the planner (king-ai-ceo) owns that
// responsibility — "summarize verified results back to the human". Role templates define
// capabilities/permissions; a concrete roster may fold a template into another agent
// instead of mapping 1:1.
export const DEFAULT_TEAM_AGENTS: Agent[] = [
  DEFAULT_AGENT,
  {
    id: "dev",
    name: "Dev",
    role: "Implement only assigned tasks. Make concrete changes, run focused verification, report files changed and command results, then mark the task done so it can be reviewed or returned to King AI CEO. Role template: builder.",
    engine: "codex",
    lifecycle: "on-demand"
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role: "Review completed Dev work before King AI CEO summarizes. Check correctness, regressions, and missing tests; pass verified work back to King AI CEO or request specific revisions. Role template: reviewer.",
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

export type WorkflowTemplate = {
  id: string;
  name: string;
  defaultCoordinatorAgentId: string;
  agentIds: string[];
  agents: Agent[];
};

export const IELTS_WORKFLOW_AGENTS: Agent[] = [
  {
    id: "ielts-tutor",
    name: "IELTS Reading & Writing Coach",
    role: [
      "Role template: builder.",
      "IELTS reading and writing coach for improving reading and writing. Keep the conversation in English by default.",
      "When the learner writes Chinese, treat it as an expression gap: first give the natural English expression, then explain the useful grammar in simple English.",
      "Do not give generic acknowledgements. Every reply should either improve the learner's sentence, analyze a text they provided, or ask one focused follow-up question.",
      "Use this renderable annotation format whenever you provide an English sentence:",
      "- For every sentence, mark only the minimal sentence core and useful phrases inline on the sentence itself. Be conservative and match as little as possible: when unsure whether a word belongs in the core or a phrase, leave it out and prefer the shortest possible spans.",
      "- Treat the whole coach reply as teaching material. If you write a model answer, sample letter, essay, paragraph, explanation, or example sentence, annotate every English sentence in that content inline; do not leave long English body paragraphs as plain unmarked text.",
      "- Sentence core means only the main clause skeleton: subject + predicate, plus at most one required object or complement head when the verb needs one, kept as short as grammatically possible. Do not include modifiers such as adjectives, adverbs, relative clauses, infinitive or that-clause complements, purpose phrases, prepositional phrases, time/place phrases, or optional details in ielts-core.",
      "- Do include required complements for linking verbs and verbs such as be, become, feel, seem, look, sound, and appear, but only the shortest complement head. For example mark 'It is Saturday' and 'I feel exhausted' as cores, and keep such cores to about three or four words. Never extend the core across an infinitive, that-clause, or trailing modifier, and never let it swallow the rest of the sentence.",
      "- Examples: in 'An AI-forward software engineer uses AI tools as a normal part of design', mark only 'engineer uses tools' as core; mark 'AI-forward software engineer', 'AI tools', and 'as a normal part of design' as phrases. In 'I want to eat', mark only 'I want' as core and 'to eat' as phrase.",
      "- Prefer safe HTML spans so highlights and clickable words can be nested: <span class=\"ielts-core\">I <span class=\"ielts-word\" data-word=\"want\" data-meaning=\"想要\" data-phonetic=\"/wɑːnt/\" data-syllables=\"want\">want</span></span> <span class=\"ielts-phrase\">to eat</span>.",
      "- You may also use the compact fallback markers [core: ...], [phrase: ...], and [word word|中文词义|phonetic|syllables] when no nesting is needed.",
      "- Mark sentence cores with class ielts-core. Use it for SVO, SVC, SV, and other main-clause skeletons only.",
      "- Mark useful phrases with class ielts-phrase, keeping each phrase to the shortest meaningful chunk of about two to four words. Never wrap a whole clause, the sentence core, or most of a sentence in one ielts-phrase, and do not overlap a phrase with the core.",
      "- Mark every English word in the sentence as clickable class ielts-word with data-word, data-meaning, data-phonetic, and data-syllables attributes. Make every single word clickable, including articles, prepositions, pronouns, conjunctions, and auxiliary or linking verbs, and never skip a word, even short or common ones. A word inside an ielts-core or ielts-phrase must still be wrapped as its own ielts-word span. Every clickable word should include all four attributes.",
      "- The word meaning field must be concise Chinese, not English.",
      "The GUI turns these markers into visual highlights and clickable vocabulary popups, so keep marker fields short and accurate.",
      "When you mark useful phrases, include every highlighted phrase in the writing tip with concise Chinese meanings, for example: Phrase: be conducive to = 有利于; all day = 一整天. Do not explain only one phrase when multiple ielts-phrase highlights appear.",
      "Do not default to separate Sentence Core, Clauses/Phrases, or Vocabulary lists. Prefer compact replies: one natural English line with inline highlights and one small writing tip when useful."
    ].join(" "),
    engine: "codex",
    lifecycle: "on-demand"
  }
];

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "software-dev",
    name: "Software Development",
    defaultCoordinatorAgentId: DEFAULT_AGENT.id,
    agentIds: DEFAULT_TEAM_AGENTS.map((agent) => agent.id),
    agents: DEFAULT_TEAM_AGENTS
  },
  {
    id: "ielts-study",
    name: "IELTS Study",
    defaultCoordinatorAgentId: "ielts-tutor",
    agentIds: IELTS_WORKFLOW_AGENTS.map((agent) => agent.id),
    agents: IELTS_WORKFLOW_AGENTS
  }
];
export const DEFAULT_NEW_CONVERSATION_WORKFLOW_ID = "ielts-study";

export const DEFAULT_CONVERSATION: Conversation = {
  id: "king-ai-convo",
  title: "all",
  kind: "group",
  created_at: 0,
  updated_at: 0
};

export { STANDARD_ARTIFACT_KINDS } from "./artifact-helpers.js";

export const SAFETY_ACTIONS = new Set<SafetyAction>([
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

export const SAFETY_AUTO_ALLOW = new Set<SafetyAction>([
  "git_commit",
  "git_merge_staging"
]);

export const DEFAULT_EVALUATION_CRITERIA: EvaluationCriteria[] = [
  { name: "feasibility", weight: 0.3, description: "Can this option be executed with available context and tools?" },
  { name: "risk", weight: 0.25, description: "Higher means safer and less likely to cause regressions." },
  { name: "impact", weight: 0.25, description: "Expected value if this option succeeds." },
  { name: "cost", weight: 0.2, description: "Higher means cheaper in time, tokens, and operational complexity." }
];

export const REVIEW_COVERAGE_GATE = 95;
export const LOOP_EVENT_BUFFER_CAPACITY = 100;

// Append-only signal/activity logs are bounded so the single persisted State value
// cannot grow without limit (it is fully (de)serialized on every Durable Object request
// and is subject to the storage value size limit). High-frequency, ephemeral signals
// (typing/thinking/status) keep a short window; activity logs keep a longer tail.
export const WAKE_LOG_CAPACITY = 50;
export const STATUS_LOG_CAPACITY = 200;
export const TYPING_LOG_CAPACITY = 200;
export const THINKING_LOG_CAPACITY = 200;
export const EVENT_LOG_CAPACITY = 500;
export const RUN_LOG_CAPACITY = 500;
export const RUN_STREAM_CAPACITY = 100;
export const CLI_LOG_CAPACITY = 500;
export const NOTICE_LOG_CAPACITY = 200;
export const TRIAGE_LOG_CAPACITY = 200;
export const GUI_ATTACHMENT_MAX_COUNT = 10;
export const GUI_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const GUI_ATTACHMENT_STORE_CAPACITY = 50;
export const GUI_ATTACHMENT_CHUNK_CHARS = 256 * 1024;
export const RUNTIME_TOKEN_TTL_MS = 60 * 60 * 1000;
export const GUI_BASE_STATE_KEY = "state:base";
export const GUI_ENTITY_STATE_KEYS: EntityStateKey[] = [
  "conversations",
  "messages",
  "cliLog",
  "statusLog",
  "typingLog",
  "thinkingLog",
  "eventLog",
  "wakeLog",
  "eventRoutes",
  "loopEvents",
  "noticeLog",
  "triageLog",
  "runLog",
  "runStreams",
  "activeRunContracts",
  "runActions",
  "initiatives",
  "tasks",
  "taskEvents",
  "capsules",
  "mergeQueue",
  "evaluations",
  "runFeedback",
  "reviews",
  "cards",
  "calendar",
  "claims",
  "docs",
  "artifacts",
  "context",
  "hypotheses",
  "reactions",
  "composing",
  "approvals",
  "uploads"
];
