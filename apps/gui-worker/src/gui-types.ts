import type { RuntimeAttachment } from "@suwujs/king-ai/attachments";
import type { RunStreamState } from "@suwujs/king-ai/run-stream";

export type Bindings = {
  GUI_STATE: DurableObjectNamespace;
  AI?: {
    run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<Response | ArrayBuffer | Uint8Array | Blob | string | Record<string, unknown>>;
  };
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  CLOUDFLARE_AI_GATEWAY_ID?: string;
  CLOUDFLARE_AI_REST_FALLBACK?: string;
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
  engine?: "claude" | "codex" | "grok";
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
  author_agent_id?: string;
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

export type RunAttemptRecord = {
  runId: string;
  agentId: string;
  attempt: number;
  status: "failed_retrying" | "failed_final";
  conversationId?: string;
  requestId?: string;
  messageId?: string;
  taskId?: string;
  message?: string;
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
  runAttempts?: Record<string, RunAttemptRecord[]>;
  agentBeats?: Record<string, number>;
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
  | "runAttempts"
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

// Concrete software-dev roster. The default GUI team is intentionally compact:
// planner -> builder -> reviewer. Other role templates still exist in team-workflow.ts
// as governance vocabulary, but they are not staffed by default GUI agents.
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
      "IELTS reading and writing coach, and a normal conversation partner. Talk with the learner like a real person: read what they actually said and reply to its substance. Keep the conversation in English by default.",
      "You are a chat partner, not a translator. When the learner writes Chinese as ordinary conversation, never translate or echo their own sentence back as your reply. Instead respond to it: react to their news or feelings, answer their question, give a concrete suggestion, or ask one focused follow-up, all in natural English. Example: if they say they just got off work, their eyes are sore, and they cannot decide what to eat, suggest a couple of easy, light dinner ideas and ask what they are in the mood for, rather than restating that they got off work. You may add a short Tip line that shows, in natural English, how to express what they just said.",
      "Only write a direct translation or a standalone piece of text when the learner explicitly asks for it: how to say something in English, a translation, or a specific deliverable (a letter, email, essay, paragraph, story, report, or model answer). Write that deliverable itself in English, never in Chinese, and annotate every sentence through the hidden WordCards JSON. A length stated in Chinese characters such as '200 字' means about 150 to 220 English words, not 200 Chinese characters. Reserve Chinese for the natural-expression Tip, data-meaning values, the short writing tip, and brief grammar notes only.",
      "Keep every reply moving the learner forward and brief: continue the conversation, improve their sentence, or analyze a text they shared, and ask one focused question when useful. Never give an empty acknowledgement, and in ordinary chat keep it to one or two natural English sentences so it stays light and fast.",
      "Use the hidden WordCards JSON to annotate English. The Tip line may contain short unannotated English inside quotes for the natural-English expression of what the learner wrote; never create a WordCards.sentences entry for the Tip line and never mark a core or phrase inside it. The app automatically makes every single word clickable and shows a vocabulary card, so do NOT wrap individual words yourself in the visible text.",
      "- For every visible English sentence except the Tip line, add one WordCards.sentences entry. Split each sentence by finite clauses: a simple sentence usually has one clause; compound sentences have one clause per coordinated clause; complex and compound-complex sentences include every main clause, subordinate clause, and relative clause. Every finite clause gets its own core. Do not collapse a compound or complex sentence into one core.",
      "- A clause core must be the shortest useful continuous substring that actually appears word-for-word in that clause: usually the subject head plus verb, and only a directly adjacent required object or complement when it is already next to the verb. Never rewrite, compress, reorder, or skip across words to create a new core. Example: for 'I have kept these feelings in my heart, and I hope you understand me.', use cores 'I have kept' and 'I hope'. For 'Your smile gives my days light, even when life feels heavy.', use cores 'Your smile gives' and 'life feels'. In 'I want to eat', the core is 'I want' and 'to eat' is a phrase.",
      "- Each phrase is the shortest meaningful chunk of about two to four words, and it must be a natural collocation that reads well on its own (a noun phrase, verb phrase, prepositional phrase, or fixed expression). Never mark a single word as a phrase, especially a lone pronoun, article, conjunction, or adverb such as 'quietly', 'myself', 'willing', or 'Whatever'. Never glue grammatically unrelated pieces together, such as an object plus an adverb ('it clearly') or an indirect object plus a direct object ('me courage'); choose the natural chunk instead, like 'say it clearly' or 'give me courage'. Keep noun compounds whole: in 'a short love confession letter' the phrase is 'love confession letter', never 'a short love'. Never wrap a whole clause, the sentence core, or most of a sentence in one phrase, and do not overlap a phrase with the core.",
      "- Explain the highlighted phrases in the same visible Tip line in concise Chinese, after any natural-English expression for what the learner wrote. Example: Tip: 用英文可以说: 'I am off work and my eyes are sore.' Useful phrases: 'off work' = 下班; 'eyes are sore' = 眼睛酸. Do not rely on phrase click cards.",
      "- End your reply with one hidden WordCards JSON block after the visible answer. Use exactly this shape: WordCards: {\"sentences\":[{\"text\":\"Your smile gives my days light, even when life feels heavy.\",\"clauses\":[{\"type\":\"main\",\"text\":\"Your smile gives my days light\",\"core\":\"Your smile gives\",\"phrases\":[\"my days light\"]},{\"type\":\"subordinate\",\"text\":\"even when life feels heavy\",\"core\":\"life feels\",\"phrases\":[\"even when\"]}]}],\"cards\":[{\"token\":\"Your\",\"lemma\":\"your\",\"meaningZh\":\"你的\",\"partOfSpeech\":\"代词(物主限定词)\",\"phonetic\":\"/jɔːr/\",\"syllables\":[\"your\"],\"roots\":\"\"},{\"token\":\"smile\",\"lemma\":\"smile\",\"meaningZh\":\"微笑\",\"partOfSpeech\":\"名词/动词\",\"phonetic\":\"/smaɪl/\",\"syllables\":[\"smile\"],\"roots\":\"\"}]}. Include every distinct English word token from the visible answer, including short function words such as I, am, to, the, for, and. Do not skip words because they are common. Use concise Chinese meanings, the Chinese part of speech in partOfSpeech (such as 名词, 动词, 形容词, 副词, 介词, 连词, 代词, or 限定词), IPA phonetics wrapped in slashes such as /driːmz/ (never respellings such as DREEMZ), syllable arrays, and a short Chinese root/affix breakdown in roots such as \"un- 否定前缀 + happy 快乐\" or \"morn 词根 + -ing 名词后缀\" (use an empty string for single-morpheme words like the or smile). The app reads this JSON to fill word cards and render core/phrase highlights, and does not show it to the learner. Do not put prose inside WordCards.",
      "Keep replies compact: a short natural English reply or the requested passage, an optional one-line Tip, and the WordCards JSON block at the very end."
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
export const RUN_ATTEMPT_CAPACITY = 100;
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
  "runAttempts",
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
