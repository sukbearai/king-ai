import { render as renderMarkdownHtml } from "@comark/html";
import { formatAttachmentPrompt } from "@suwujs/king-ai/attachments";
import type { RunStreamEvent, RunStreamState } from "@suwujs/king-ai/run-stream";
import { initialRunStreamState, reduceRunStream, renderRunStreamCard } from "@suwujs/king-ai/run-stream";
import { formatMessageRouteSummary, messageRouteTag, sortRuntimeMessages } from "@suwujs/king-ai/message-routing";
import { selectOwnerRole } from "@suwujs/king-ai/team-routing";
import { defaultTeamSpec, requiredCapabilitiesForText, roleTemplateForAgent } from "@suwujs/king-ai/team-workflow";
import { taskDoneTransition, workflowCardFromTask, workflowReadiness } from "@suwujs/king-ai/workflow-core";
import { sanitizeTenantId, displayNameForAuthUser } from "./gui-auth.js";
import {
  artifactCandidateFromArgs as artifactCandidateFromArgsHelper,
  checkArtifactQuality,
  findArtifactInState,
  formatArtifactLine,
  formatArtifactQualityCheck,
  parseMetadataJson
} from "./artifact-helpers.js";
import {
  normalizeNonnegativeInt,
  normalizePositiveInt,
  parseAllowedPaths,
  pathConflict,
  readBooleanOption,
  readNumberOption,
  readOption,
  stripOptions,
  taskScopeConflicts
} from "./gui-cli-options.js";
import {
  CLI_LOG_CAPACITY,
  DEFAULT_AGENT,
  DEFAULT_CONVERSATION,
  DEFAULT_EVALUATION_CRITERIA,
  DEFAULT_NEW_CONVERSATION_WORKFLOW_ID,
  DEFAULT_TEAM_AGENTS,
  EVENT_LOG_CAPACITY,
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
  AgendaPayload,
  ApprovalRequest,
  Artifact,
  AuthUser,
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
  EntityState,
  EntityStateKey,
  Env,
  EvaluationCriteria,
  EvaluationRecord,
  EvaluationScore,
  EventRoute,
  ExecutionPlan,
  ExternalEvent,
  GuiConversationPayload,
  GuiTaskUpdatePayload,
  Hypothesis,
  HypothesisStatus,
  Initiative,
  InitiativeStatus,
  LoopClassification,
  LoopEvent,
  LoopEventType,
  LoopSnapshot,
  MergeRequest,
  MergeStatus,
  Message,
  PlannedTask,
  Reaction,
  RemoteAssistGrant,
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

function isAgentLifecycle(value: unknown): value is AgentLifecycle {
  return value === "on-demand" || value === "24/7" || value === "idle_cached" || value === "disabled";
}

function token(request: Request): string {
  const raw = request.headers.get("Authorization") || "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : "";
}

function tenantHeader(request: Request): string {
  return sanitizeTenantId(request.headers.get("X-King-AI-Tenant") || "global");
}

function normalizeAgentId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id) return undefined;
  return id;
}

function normalizeRuntimeTokens(value: Record<string, string> | undefined): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [agentId, tokenValue] of Object.entries(value ?? {})) {
    const id = normalizeAgentId(agentId);
    if (id && typeof tokenValue === "string") next[id] = tokenValue;
  }
  return next;
}

function normalizeRuntimeTokenMeta(value: Record<string, RuntimeTokenMeta> | undefined, runtimeTokens: Record<string, string>): Record<string, RuntimeTokenMeta> {
  const next: Record<string, RuntimeTokenMeta> = {};
  const now = Date.now();
  for (const [agentId, tokenValue] of Object.entries(runtimeTokens)) {
    const id = normalizeAgentId(agentId);
    if (!id || !tokenValue) continue;
    const row = value?.[agentId] ?? value?.[id];
    const expiresAt = row && row.token === tokenValue && Number.isFinite(row.expiresAt) ? row.expiresAt : now + RUNTIME_TOKEN_TTL_MS;
    next[id] = { token: tokenValue, expiresAt };
  }
  return next;
}

function entityStateStorageKey(key: EntityStateKey): string {
  return `state:${key}`;
}

function stableStorageValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function stripEntityState(state: State): State {
  const base = { ...state };
  for (const key of GUI_ENTITY_STATE_KEYS) {
    delete (base as unknown as Partial<EntityState>)[key];
  }
  return base;
}

function normalizeRemoteAssistGrant(value: unknown): RemoteAssistGrant | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Partial<RemoteAssistGrant>;
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
  state.remoteAssist = normalizeRemoteAssistGrant(state.remoteAssist);
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
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul"
]);

const SAFE_MARK_CLASS_PATTERN = /^(ielts-core|ielts-phrase|ielts-word)$/;
const SAFE_URI_PATTERN = /^(https?:|mailto:|\/(?!\/)|#)/i;

function sanitizeMarkdownHtml(html: string): string {
  return html
    .replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*style\b[\s\S]*?<\s*\/\s*style\s*>/gi, "")
    .replace(/<\/?([a-zA-Z][\w:-]*)([^>]*)>/g, (tag, rawName: string, rawAttrs: string) => {
      const name = rawName.toLowerCase();
      if (!SAFE_MARKDOWN_TAGS.has(name)) return "";
      if (tag.startsWith("</")) return `</${name}>`;
      const attrs = name === "a" ? sanitizeLinkAttributes(rawAttrs) : name === "span" ? sanitizeSpanAttributes(rawAttrs) : "";
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

function sanitizeSpanAttributes(rawAttrs: string): string {
  const attrs: string[] = [];
  const classMatch = rawAttrs.match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const className = decodeHtmlAttribute(classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").trim();
  if (SAFE_MARK_CLASS_PATTERN.test(className)) attrs.push(` class="${className}"`);
  for (const key of ["data-word", "data-meaning", "data-phonetic", "data-syllables"]) {
    const pattern = new RegExp(`\\s${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = rawAttrs.match(pattern);
    const value = decodeHtmlAttribute(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    if (value) attrs.push(` ${key}="${escapeHtmlAttribute(value)}"`);
  }
  return attrs.join("");
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch] ?? ch);
}

// Closed-class / very high-frequency words the coach model reliably skips when it
// annotates a sentence. The fallback wrapper below fills these in with a concise card so
// clicking a common word never lands on "暂无词义". Content words are almost always
// annotated by the model itself, so this table intentionally stays to function words plus a
// few ubiquitous ones. Keys are lowercase; syllables stay empty for monosyllabic words so the
// card hides that row instead of echoing the word back.
const COMMON_WORD_CARDS: Record<string, { meaning: string; phonetic: string; syllables: string }> = {
  // articles
  a: { meaning: "一个（不定冠词）", phonetic: "/ə/", syllables: "" },
  an: { meaning: "一个（不定冠词）", phonetic: "/ən/", syllables: "" },
  the: { meaning: "这；那（定冠词）", phonetic: "/ðə/", syllables: "" },
  // subject pronouns
  i: { meaning: "我", phonetic: "/aɪ/", syllables: "" },
  you: { meaning: "你；你们", phonetic: "/juː/", syllables: "" },
  he: { meaning: "他", phonetic: "/hiː/", syllables: "" },
  she: { meaning: "她", phonetic: "/ʃiː/", syllables: "" },
  it: { meaning: "它", phonetic: "/ɪt/", syllables: "" },
  we: { meaning: "我们", phonetic: "/wiː/", syllables: "" },
  they: { meaning: "他们", phonetic: "/ðeɪ/", syllables: "" },
  // object pronouns
  me: { meaning: "我（宾格）", phonetic: "/miː/", syllables: "" },
  him: { meaning: "他（宾格）", phonetic: "/hɪm/", syllables: "" },
  her: { meaning: "她；她的", phonetic: "/hɜːr/", syllables: "" },
  us: { meaning: "我们（宾格）", phonetic: "/ʌs/", syllables: "" },
  them: { meaning: "他们（宾格）", phonetic: "/ðem/", syllables: "" },
  // possessives
  my: { meaning: "我的", phonetic: "/maɪ/", syllables: "" },
  your: { meaning: "你的", phonetic: "/jɔːr/", syllables: "" },
  his: { meaning: "他的", phonetic: "/hɪz/", syllables: "" },
  its: { meaning: "它的", phonetic: "/ɪts/", syllables: "" },
  our: { meaning: "我们的", phonetic: "/ˈaʊər/", syllables: "" },
  their: { meaning: "他们的", phonetic: "/ðer/", syllables: "" },
  mine: { meaning: "我的（名词性）", phonetic: "/maɪn/", syllables: "" },
  yours: { meaning: "你的（名词性）", phonetic: "/jɔːrz/", syllables: "" },
  // demonstratives
  this: { meaning: "这个", phonetic: "/ðɪs/", syllables: "" },
  that: { meaning: "那个；那", phonetic: "/ðæt/", syllables: "" },
  these: { meaning: "这些", phonetic: "/ðiːz/", syllables: "" },
  those: { meaning: "那些", phonetic: "/ðoʊz/", syllables: "" },
  // wh-words
  who: { meaning: "谁", phonetic: "/huː/", syllables: "" },
  whom: { meaning: "谁（宾格）", phonetic: "/huːm/", syllables: "" },
  whose: { meaning: "谁的", phonetic: "/huːz/", syllables: "" },
  which: { meaning: "哪一个", phonetic: "/wɪtʃ/", syllables: "" },
  what: { meaning: "什么", phonetic: "/wʌt/", syllables: "" },
  when: { meaning: "何时；当……时", phonetic: "/wen/", syllables: "" },
  where: { meaning: "哪里", phonetic: "/wer/", syllables: "" },
  why: { meaning: "为什么", phonetic: "/waɪ/", syllables: "" },
  how: { meaning: "怎样；如何", phonetic: "/haʊ/", syllables: "" },
  // prepositions
  to: { meaning: "到；向（不定式标记）", phonetic: "/tuː/", syllables: "" },
  of: { meaning: "……的", phonetic: "/ʌv/", syllables: "" },
  in: { meaning: "在……里", phonetic: "/ɪn/", syllables: "" },
  on: { meaning: "在……上", phonetic: "/ɑːn/", syllables: "" },
  at: { meaning: "在（某处/某时）", phonetic: "/æt/", syllables: "" },
  by: { meaning: "由；通过", phonetic: "/baɪ/", syllables: "" },
  for: { meaning: "为了；给", phonetic: "/fɔːr/", syllables: "" },
  with: { meaning: "和；用", phonetic: "/wɪð/", syllables: "" },
  from: { meaning: "从", phonetic: "/frʌm/", syllables: "" },
  about: { meaning: "关于；大约", phonetic: "/əˈbaʊt/", syllables: "a-bout" },
  as: { meaning: "作为；像", phonetic: "/æz/", syllables: "" },
  into: { meaning: "进入", phonetic: "/ˈɪntuː/", syllables: "in-to" },
  like: { meaning: "像；喜欢", phonetic: "/laɪk/", syllables: "" },
  through: { meaning: "穿过；经由", phonetic: "/θruː/", syllables: "" },
  over: { meaning: "在……上方；超过", phonetic: "/ˈoʊvər/", syllables: "o-ver" },
  under: { meaning: "在……下面", phonetic: "/ˈʌndər/", syllables: "un-der" },
  between: { meaning: "在……之间", phonetic: "/bɪˈtwiːn/", syllables: "be-tween" },
  during: { meaning: "在……期间", phonetic: "/ˈdʊrɪŋ/", syllables: "dur-ing" },
  before: { meaning: "在……之前", phonetic: "/bɪˈfɔːr/", syllables: "be-fore" },
  after: { meaning: "在……之后", phonetic: "/ˈæftər/", syllables: "af-ter" },
  since: { meaning: "自从；既然", phonetic: "/sɪns/", syllables: "" },
  until: { meaning: "直到", phonetic: "/ənˈtɪl/", syllables: "un-til" },
  without: { meaning: "没有", phonetic: "/wɪˈðaʊt/", syllables: "with-out" },
  within: { meaning: "在……之内", phonetic: "/wɪˈðɪn/", syllables: "with-in" },
  around: { meaning: "围绕；大约", phonetic: "/əˈraʊnd/", syllables: "a-round" },
  toward: { meaning: "朝向", phonetic: "/tɔːrd/", syllables: "" },
  off: { meaning: "离开；关掉", phonetic: "/ɔːf/", syllables: "" },
  out: { meaning: "出；在外", phonetic: "/aʊt/", syllables: "" },
  up: { meaning: "向上", phonetic: "/ʌp/", syllables: "" },
  down: { meaning: "向下", phonetic: "/daʊn/", syllables: "" },
  near: { meaning: "靠近", phonetic: "/nɪr/", syllables: "" },
  // conjunctions
  and: { meaning: "和；并且", phonetic: "/ænd/", syllables: "" },
  or: { meaning: "或者", phonetic: "/ɔːr/", syllables: "" },
  but: { meaning: "但是", phonetic: "/bʌt/", syllables: "" },
  so: { meaning: "所以；如此", phonetic: "/soʊ/", syllables: "" },
  if: { meaning: "如果", phonetic: "/ɪf/", syllables: "" },
  because: { meaning: "因为", phonetic: "/bɪˈkɔːz/", syllables: "be-cause" },
  while: { meaning: "当……时；然而", phonetic: "/waɪl/", syllables: "" },
  than: { meaning: "比", phonetic: "/ðæn/", syllables: "" },
  though: { meaning: "虽然", phonetic: "/ðoʊ/", syllables: "" },
  although: { meaning: "尽管", phonetic: "/ɔːlˈðoʊ/", syllables: "al-though" },
  unless: { meaning: "除非", phonetic: "/ənˈles/", syllables: "un-less" },
  whether: { meaning: "是否", phonetic: "/ˈweðər/", syllables: "wheth-er" },
  nor: { meaning: "也不", phonetic: "/nɔːr/", syllables: "" },
  yet: { meaning: "然而；还（没）", phonetic: "/jet/", syllables: "" },
  once: { meaning: "一旦；曾经", phonetic: "/wʌns/", syllables: "" },
  // be / have / do
  am: { meaning: "是（与 I 连用）", phonetic: "/æm/", syllables: "" },
  is: { meaning: "是（三单）", phonetic: "/ɪz/", syllables: "" },
  are: { meaning: "是（复数）", phonetic: "/ɑːr/", syllables: "" },
  was: { meaning: "是（过去）", phonetic: "/wʌz/", syllables: "" },
  were: { meaning: "是（过去复数）", phonetic: "/wɜːr/", syllables: "" },
  be: { meaning: "是；成为", phonetic: "/biː/", syllables: "" },
  been: { meaning: "是（过去分词）", phonetic: "/bɪn/", syllables: "" },
  being: { meaning: "是（现在分词）", phonetic: "/ˈbiːɪŋ/", syllables: "be-ing" },
  have: { meaning: "有；已经", phonetic: "/hæv/", syllables: "" },
  has: { meaning: "有；已经（三单）", phonetic: "/hæz/", syllables: "" },
  had: { meaning: "有；已经（过去）", phonetic: "/hæd/", syllables: "" },
  do: { meaning: "做；助动词", phonetic: "/duː/", syllables: "" },
  does: { meaning: "做（三单）", phonetic: "/dʌz/", syllables: "" },
  did: { meaning: "做（过去）", phonetic: "/dɪd/", syllables: "" },
  // modals
  will: { meaning: "将；会", phonetic: "/wɪl/", syllables: "" },
  would: { meaning: "会；愿", phonetic: "/wʊd/", syllables: "" },
  can: { meaning: "能；可以", phonetic: "/kæn/", syllables: "" },
  could: { meaning: "能（过去/委婉）", phonetic: "/kʊd/", syllables: "" },
  shall: { meaning: "将；应", phonetic: "/ʃæl/", syllables: "" },
  should: { meaning: "应该", phonetic: "/ʃʊd/", syllables: "" },
  may: { meaning: "可能；可以", phonetic: "/meɪ/", syllables: "" },
  might: { meaning: "可能", phonetic: "/maɪt/", syllables: "" },
  must: { meaning: "必须", phonetic: "/mʌst/", syllables: "" },
  // negatives & common adverbs / quantifiers
  not: { meaning: "不", phonetic: "/nɑːt/", syllables: "" },
  no: { meaning: "不；没有", phonetic: "/noʊ/", syllables: "" },
  never: { meaning: "从不", phonetic: "/ˈnevər/", syllables: "nev-er" },
  very: { meaning: "非常", phonetic: "/ˈveri/", syllables: "ve-ry" },
  too: { meaning: "太；也", phonetic: "/tuː/", syllables: "" },
  also: { meaning: "也", phonetic: "/ˈɔːlsoʊ/", syllables: "al-so" },
  just: { meaning: "只是；刚刚", phonetic: "/dʒʌst/", syllables: "" },
  only: { meaning: "只；仅", phonetic: "/ˈoʊnli/", syllables: "on-ly" },
  even: { meaning: "甚至", phonetic: "/ˈiːvən/", syllables: "e-ven" },
  still: { meaning: "仍然", phonetic: "/stɪl/", syllables: "" },
  again: { meaning: "再次", phonetic: "/əˈɡen/", syllables: "a-gain" },
  then: { meaning: "然后；那时", phonetic: "/ðen/", syllables: "" },
  there: { meaning: "那里", phonetic: "/ðer/", syllables: "" },
  here: { meaning: "这里", phonetic: "/hɪr/", syllables: "" },
  now: { meaning: "现在", phonetic: "/naʊ/", syllables: "" },
  more: { meaning: "更多", phonetic: "/mɔːr/", syllables: "" },
  most: { meaning: "最；大多数", phonetic: "/moʊst/", syllables: "" },
  much: { meaning: "许多（不可数）", phonetic: "/mʌtʃ/", syllables: "" },
  many: { meaning: "许多（可数）", phonetic: "/ˈmeni/", syllables: "ma-ny" },
  some: { meaning: "一些", phonetic: "/sʌm/", syllables: "" },
  any: { meaning: "任何", phonetic: "/ˈeni/", syllables: "a-ny" },
  all: { meaning: "全部", phonetic: "/ɔːl/", syllables: "" },
  both: { meaning: "两者", phonetic: "/boʊθ/", syllables: "" },
  each: { meaning: "每个", phonetic: "/iːtʃ/", syllables: "" },
  every: { meaning: "每个", phonetic: "/ˈevri/", syllables: "eve-ry" },
  few: { meaning: "很少", phonetic: "/fjuː/", syllables: "" },
  little: { meaning: "少；小", phonetic: "/ˈlɪtl/", syllables: "lit-tle" },
  such: { meaning: "这样的", phonetic: "/sʌtʃ/", syllables: "" },
  own: { meaning: "自己的", phonetic: "/oʊn/", syllables: "" },
  same: { meaning: "相同的", phonetic: "/seɪm/", syllables: "" },
  other: { meaning: "其他的", phonetic: "/ˈʌðər/", syllables: "oth-er" },
  another: { meaning: "另一个", phonetic: "/əˈnʌðər/", syllables: "an-oth-er" },
  however: { meaning: "然而", phonetic: "/haʊˈevər/", syllables: "how-ev-er" },
  always: { meaning: "总是", phonetic: "/ˈɔːlweɪz/", syllables: "al-ways" },
  often: { meaning: "经常", phonetic: "/ˈɔːfən/", syllables: "of-ten" },
  really: { meaning: "真的", phonetic: "/ˈriːəli/", syllables: "real-ly" },
  well: { meaning: "好；嗯", phonetic: "/wel/", syllables: "" },
  yes: { meaning: "是的", phonetic: "/jes/", syllables: "" },
  // common contractions
  "i'm": { meaning: "我是（I am）", phonetic: "/aɪm/", syllables: "" },
  "it's": { meaning: "它是（it is）", phonetic: "/ɪts/", syllables: "" },
  "don't": { meaning: "不（do not）", phonetic: "/doʊnt/", syllables: "" },
  "can't": { meaning: "不能（cannot）", phonetic: "/kænt/", syllables: "" },
  "that's": { meaning: "那是（that is）", phonetic: "/ðæts/", syllables: "" },
  "you're": { meaning: "你是（you are）", phonetic: "/jʊr/", syllables: "" },
  "i've": { meaning: "我已（I have）", phonetic: "/aɪv/", syllables: "" }
};

type IeltsCardDetails = { meaning: string; phonetic: string; syllables: string };
type IeltsGlossary = { words: Map<string, IeltsCardDetails> };

function emptyIeltsGlossary(): IeltsGlossary {
  return { words: new Map() };
}

// Word cards draw their details from the coach's trailing Glossary first (context-specific
// content words), then fall back to the built-in function-word dictionary. A word with no
// details anywhere stays clickable but carries data-word only.
function lookupWordCard(key: string, glossary?: IeltsGlossary): IeltsCardDetails | null {
  const dict = COMMON_WORD_CARDS[key];
  const glossCard = glossary?.words.get(key);
  if (glossCard) {
    return {
      meaning: glossCard.meaning,
      phonetic: glossCard.phonetic || dict?.phonetic || "",
      syllables: glossCard.syllables || dict?.syllables || ""
    };
  }
  if (dict) return { meaning: dict.meaning, phonetic: dict.phonetic, syllables: dict.syllables };
  return null;
}

function clickableWordSpan(word: string, glossary?: IeltsGlossary): string {
  const escapedWord = escapeHtmlAttribute(word);
  const display = escapeHtml(word);
  const key = word.toLowerCase();
  // Possessive and plural-possessive forms (teacher's, students') fall back to the base word so
  // the card still shows a meaning. Contractions like don't keep their own dictionary entry,
  // which the direct lookup above resolves before any stripping.
  const baseKey = key.replace(/['’]s?$/i, "");
  const card = lookupWordCard(key, glossary) ?? (baseKey !== key ? lookupWordCard(baseKey, glossary) : null);
  if (!card) {
    return `<span class="ielts-word" data-word="${escapedWord}">${display}</span>`;
  }
  const attrs =
    ` data-word="${escapedWord}"` +
    ` data-meaning="${escapeHtmlAttribute(card.meaning)}"` +
    (card.phonetic ? ` data-phonetic="${escapeHtmlAttribute(card.phonetic)}"` : "") +
    (card.syllables ? ` data-syllables="${escapeHtmlAttribute(card.syllables)}"` : "");
  return `<span class="ielts-word"${attrs}>${display}</span>`;
}

// The coach supplies word details in a trailing "Glossary:" line instead of wrapping every word
// inline. Parse `word = 中文 | /phonetic/ | syl-la-bles` pairs, then strip the line so the
// learner sees only the annotated sentence, not the raw list.
function extractIeltsGlossary(body: string): { text: string; glossary: IeltsGlossary } {
  const glossary = emptyIeltsGlossary();
  const marker = body.search(/(^|\n)[^\S\n]*(?:Glossary|词表|词汇)[^\S\n]*[:：]/i);
  if (marker < 0) return { text: body, glossary };
  const tail = body.slice(marker);
  const pairPattern = /([A-Za-z][A-Za-z'’-]*)\s*[=＝]\s*([^;；\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pairPattern.exec(tail))) {
    const term = match[1].trim().toLowerCase();
    const [meaning = "", phonetic = "", syllables = ""] = match[2].split("|").map((part) => part.trim());
    if (term && meaning && !glossary.words.has(term)) glossary.words.set(term, { meaning, phonetic, syllables });
  }
  return { text: body.slice(0, marker).replace(/\s+$/, ""), glossary };
}

function cleanupRepeatedIeltsCoreText(markdown: string): string {
  return markdown.replace(/\[core:\s*([^\]\n]+)\]([ \t]+)([A-Za-z][A-Za-z'’]*(?:[ \t]+[A-Za-z][A-Za-z'’]*){0,8})/g, (match, rawCore: string, spaces: string, rawTail: string) => {
    const coreWords = rawCore.trim().split(/\s+/);
    const tailWords = rawTail.trim().split(/\s+/);
    let removeCount = 0;
    for (let start = 0; start < coreWords.length; start += 1) {
      const suffix = coreWords.slice(start);
      if (suffix.length > tailWords.length) continue;
      if (suffix.every((word, index) => word.toLowerCase() === tailWords[index].toLowerCase())) {
        removeCount = suffix.length;
        break;
      }
    }
    if (removeCount === 0) return match;
    const rest = tailWords.slice(removeCount).join(" ");
    if (removeCount === 1 && rest) return match;
    return `[core: ${rawCore.trim()}]${rest ? `${spaces}${rest}` : ""}`;
  });
}

function renderIeltsAnnotations(markdown: string): string {
  return markdown
    .replace(/\[word\s+([^\]\n|]+)\|([^\]\n|]+)\|([^\]\n|]+)\|([^\]\n|]+)\]/g, (_match, word: string, meaning: string, phonetic: string, syllables: string) =>
      `<span class="ielts-word" data-word="${escapeHtmlAttribute(word.trim())}" data-meaning="${escapeHtmlAttribute(meaning.trim())}" data-phonetic="${escapeHtmlAttribute(phonetic.trim())}" data-syllables="${escapeHtmlAttribute(syllables.trim())}">${escapeHtml(word.trim())}</span>`
    )
    .replace(/\[core:\s*([^\]\n]+)\]/g, (_match, core: string) => `<span class="ielts-core">${escapeHtml(core.trim())}</span>`)
    .replace(/\[phrase:\s*([^\]\n]+)\]/g, (_match, phrase: string) => `<span class="ielts-phrase">${escapeHtml(phrase.trim())}</span>`);
}

function renderFallbackClickableWords(html: string, glossary?: IeltsGlossary): string {
  const skipTags = new Set(["a", "code", "pre", "script", "style"]);
  const stack: Array<{ name: string; className: string }> = [];
  return html.split(/(<[^>]+>)/g).map((part) => {
    if (!part) return part;
    if (part.startsWith("<")) {
      const close = part.match(/^<\/\s*([a-zA-Z][\w:-]*)/);
      if (close) {
        const name = close[1].toLowerCase();
        for (let idx = stack.length - 1; idx >= 0; idx -= 1) {
          const current = stack.pop();
          if (current?.name === name) break;
        }
        return part;
      }
      const open = part.match(/^<\s*([a-zA-Z][\w:-]*)([^>]*)>/);
      if (open && !part.endsWith("/>")) {
        const name = open[1].toLowerCase();
        const classMatch = open[2].match(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const className = decodeHtmlAttribute(classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").trim();
        stack.push({ name, className });
      }
      return part;
    }
    if (stack.some((entry) => skipTags.has(entry.name) || entry.className === "ielts-word")) return part;
    return part.replace(/\b[A-Za-z]+(?:'[A-Za-z]+)?\b/g, (word) => clickableWordSpan(word, glossary));
  }).join("");
}

function shouldRenderIeltsClickableWords(message: Message): boolean {
  return message.author_kind === "agent" && message.author_name === "IELTS Reading & Writing Coach";
}

async function renderMessageMarkdown(message: Message): Promise<Message> {
  if (message.status === "pending" || message.kind === "system") return { ...message };
  try {
    const isIelts = shouldRenderIeltsClickableWords(message);
    const { text, glossary } = isIelts
      ? extractIeltsGlossary(message.body || "")
      : { text: message.body || "", glossary: emptyIeltsGlossary() };
    const rendered = await renderMarkdownHtml(renderIeltsAnnotations(cleanupRepeatedIeltsCoreText(text)));
    const sanitized = sanitizeMarkdownHtml(rendered);
    const body_html = isIelts ? renderFallbackClickableWords(sanitized, glossary) : sanitized;
    return { ...message, body_html };
  } catch {
    return { ...message };
  }
}

type GuiStateResponse = State | Omit<State, "deviceToken" | "runtimeToken" | "runtimeTokens" | "runtimeTokenMeta" | "pairingCode" | "remoteAssist">;

async function stateForGui(state: State, redactSecrets = false): Promise<GuiStateResponse> {
  const visible = {
    ...state,
    messages: await Promise.all(state.messages.map(renderMessageMarkdown))
  };
  if (!redactSecrets) return visible;
  const {
    deviceToken: _deviceToken,
    runtimeToken: _runtimeToken,
    runtimeTokens: _runtimeTokens,
    runtimeTokenMeta: _runtimeTokenMeta,
    pairingCode: _pairingCode,
    remoteAssist: _remoteAssist,
    ...redacted
  } = visible;
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
    source: artifact.source
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
        workflowId: normalizeWorkflowId(row.workflowId),
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
    workflowId: normalizeWorkflowId(byId.get(DEFAULT_CONVERSATION.id)?.workflowId),
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
      workflowId: "software-dev",
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
  const found = findConversation(state, conversationId);
  if (found) return found;
  const now = Date.now();
  const conversation: Conversation = {
    id: conversationId,
    title: conversationId === DEFAULT_CONVERSATION.id ? DEFAULT_CONVERSATION.title : conversationId,
    kind: "group",
    created_at: now,
    updated_at: now,
    workflowId: "software-dev",
    teamMode: "team",
    coordinatorAgentId: DEFAULT_AGENT.id,
    teamAgentIds: normalizeTeamAgentIds(undefined),
    teamSnapshot: undefined
  };
  state.conversations.push(conversation);
  return conversation;
}

function findConversation(state: State, id: string | undefined): Conversation | undefined {
  const conversationId = id?.trim() || DEFAULT_CONVERSATION.id;
  return state.conversations.find((row) => row.id === conversationId);
}

function defaultTeamAgents(): Agent[] {
  return defaultWorkflowAgents().map((agent) => ({ ...agent }));
}

function defaultTeamAgentIds(): string[] {
  return DEFAULT_TEAM_AGENTS.map((agent) => agent.id);
}

function defaultWorkflowAgents(): Agent[] {
  const byId = new Map<string, Agent>();
  for (const workflow of WORKFLOW_TEMPLATES) {
    for (const agent of workflow.agents) byId.set(agent.id, agent);
  }
  return [...byId.values()];
}

function workflowAgentIdsFor(state: State, workflow: WorkflowTemplate): string[] {
  return state.workflowAgentIds?.[workflow.id]?.length ? state.workflowAgentIds[workflow.id] : workflow.agentIds;
}

function normalizeWorkflowAgentIds(value: unknown, agents: Agent[]): Record<string, string[]> {
  const availableIds = new Set(agents.map((agent) => agent.id));
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const normalized: Record<string, string[]> = {};
  for (const workflow of WORKFLOW_TEMPLATES) {
    const incomingIds = normalizeStringList(input[workflow.id]).map(normalizeAgentId).filter((id): id is string => Boolean(id));
    const ids = [...new Set((incomingIds.length ? incomingIds : workflow.agentIds).filter((id) => availableIds.has(id)))];
    if (!ids.includes(workflow.defaultCoordinatorAgentId) && availableIds.has(workflow.defaultCoordinatorAgentId)) ids.unshift(workflow.defaultCoordinatorAgentId);
    normalized[workflow.id] = ids.length ? ids : workflow.agentIds;
  }
  return normalized;
}

function normalizeWorkflowAgentDefinitions(value: unknown): Agent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((agent) => {
    const normalized = normalizeWorkflowAgentDefinition(agent);
    return normalized ? [normalized] : [];
  });
}

function normalizeWorkflowAgentDefinition(value: unknown): Agent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Partial<Agent>;
  const id = normalizeAgentId(row.id);
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
  const role = typeof row.role === "string" && row.role.trim() ? row.role.trim() : "Workflow agent.";
  if (!id || !name) return undefined;
  return {
    id,
    name,
    role,
    engine: row.engine === "claude" || row.engine === "codex" ? row.engine : "codex",
    lifecycle: isAgentLifecycle(row.lifecycle) ? row.lifecycle : "on-demand",
    model: typeof row.model === "string" && row.model.trim() ? row.model.trim() : undefined,
    fastModel: typeof row.fastModel === "string" && row.fastModel.trim() ? row.fastModel.trim() : undefined,
    events: Array.isArray(row.events) ? row.events.filter((event): event is string => typeof event === "string" && Boolean(event.trim())) : undefined
  };
}

function upsertAgents(current: Agent[], incoming: Agent[]): Agent[] {
  const byId = new Map(normalizeAgents(current).map((agent) => [agent.id, agent]));
  for (const agent of incoming) byId.set(agent.id, { ...byId.get(agent.id), ...agent });
  return normalizeAgents([...byId.values()]);
}

function workflowTemplateById(value: unknown): WorkflowTemplate {
  const id = normalizeWorkflowId(value);
  return WORKFLOW_TEMPLATES.find((workflow) => workflow.id === id) ?? WORKFLOW_TEMPLATES[0];
}

function workflowTemplateByIdOrUndefined(value: unknown): WorkflowTemplate | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return WORKFLOW_TEMPLATES.find((workflow) => workflow.id === id);
}

function normalizeWorkflowId(value: unknown): string {
  if (typeof value !== "string") return "software-dev";
  const id = value.trim();
  return WORKFLOW_TEMPLATES.some((workflow) => workflow.id === id) ? id : "software-dev";
}

function normalizeTeamMode(value: unknown): NonNullable<Conversation["teamMode"]> {
  return value === "single" || value === "custom" || value === "team" ? value : "team";
}

function normalizeTeamAgentIds(value: unknown): string[] {
  const ids = Array.isArray(value) ? value.map(normalizeAgentId).filter((id): id is string => Boolean(id)) : [];
  return [...new Set(ids.length ? ids : defaultTeamAgentIds())];
}

function normalizeConversationTeam(state: State, payload: GuiConversationPayload, previous?: Conversation): Required<Pick<Conversation, "workflowId" | "teamMode" | "coordinatorAgentId" | "teamAgentIds">> {
  const workflow = workflowTemplateById(payload.workflowId ?? previous?.workflowId);
  const mode = normalizeTeamMode(payload.teamMode ?? previous?.teamMode);
  const workflowAgentIds = workflowAgentIdsFor(state, workflow);
  const workflowIds = new Set(workflowAgentIds);
  const requestedCoordinatorId = normalizeAgentId(payload.coordinatorAgentId ?? previous?.coordinatorAgentId);
  const coordinator = findAgent(state, requestedCoordinatorId && workflowIds.has(requestedCoordinatorId) ? requestedCoordinatorId : workflow.defaultCoordinatorAgentId)
    ?? findAgent(state, workflowAgentIds[0])
    ?? defaultAgentFor(state);
  if (mode === "single") {
    return { workflowId: workflow.id, teamMode: mode, coordinatorAgentId: coordinator.id, teamAgentIds: [coordinator.id] };
  }
  if (mode === "custom") {
    const requestedIds = normalizeStringList(payload.teamAgentIds).map(normalizeAgentId).filter((id): id is string => Boolean(id));
    const ids = [...new Set([coordinator.id, ...requestedIds])]
      .filter((id) => workflowIds.has(id) && Boolean(findAgent(state, id)));
    return { workflowId: workflow.id, teamMode: mode, coordinatorAgentId: coordinator.id, teamAgentIds: ids.length ? ids : [coordinator.id] };
  }
  const teamAgentIds = workflowAgentIds.filter((id) => Boolean(findAgent(state, id)));
  return { workflowId: workflow.id, teamMode: "team", coordinatorAgentId: coordinator.id, teamAgentIds: teamAgentIds.length ? teamAgentIds : [coordinator.id] };
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
    workflowId: normalizeWorkflowId(row.workflowId),
    mode: normalizeTeamMode(row.mode),
    coordinatorAgentId,
    teamAgentIds,
    agents: agents.map((agent) => ({ ...agent, id: normalizeAgentId(agent.id) ?? agent.id })),
    createdAt: typeof row.createdAt === "number" ? row.createdAt : Date.now()
  };
}

function buildConversationTeamSnapshot(
  state: State,
  team: Required<Pick<Conversation, "workflowId" | "teamMode" | "coordinatorAgentId" | "teamAgentIds">>,
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
    workflowId: team.workflowId,
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
  for (const agent of [...DEFAULT_TEAM_AGENTS, ...IELTS_WORKFLOW_AGENTS]) {
    const existing = byId.get(agent.id);
    byId.set(agent.id, { ...agent, ...existing });
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
  const now = Date.now();
  for (const [agentId, row] of Object.entries(state.runtimeTokenMeta ?? {})) {
    if (row.token === runtimeToken && row.expiresAt > now) return agentId;
  }
  return null;
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
      reviewer ? "Reviewer approves or requests specific revisions before Planner summarizes." : "The task status and result are recorded without requiring a separate chat summary."
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
  const reviewer = task.reviewerAgentId ? findAgent(state, task.reviewerAgentId) ?? reviewerAgentFor(state) : undefined;
  const transition = taskDoneTransition(workflowCardFromTask(task), actor.id, {
    coordinatorId: task.coordinatorAgentId ?? DEFAULT_AGENT.id,
    reviewerId: reviewer?.id,
    hasConversation: Boolean(task.conversationId)
  });
  task.status = transition.status === "review" ? "review" : "done";
  task.assignee = transition.assignee;
  if (transition.reviewResult) {
    task.reviewResult = transition.reviewResult;
    task.reviewedByAgentId = transition.reviewedBy;
    task.reviewedAt = Date.now();
  }
  if (task.status === "review" && reviewer) task.reviewerAgentId = reviewer.id;
  task.updated_at = Date.now();
  if (previousStatus !== task.status) pushTaskTransition(state, task, previousStatus);
  if (task.status === "review") {
    queueTaskReviewMessage(state, task, actor.id);
    return `Task ${task.id} submitted for review by ${task.assignee}.`;
  }
  if (task.conversationId) {
    queueTaskCompletionMessage(state, task, { fromName: actor.name, actorAgentId: actor.id });
    return `Task ${task.id} marked done and returned to ${task.assignee}.`;
  }
  return `Task ${task.id} marked done.`;
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
  updatePendingForTask(state, task, `等待 ${target.id} 评审...`);
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
  updatePendingForTask(state, task, `${target.id} 正在根据评审意见修改...`);
  conversation.updated_at = now;
}

function queueTaskCompletionMessage(state: State, task: Task, options: { fromName?: string; actorAgentId?: string } = {}): void {
  const ceo = findAgent(state, task.coordinatorAgentId) ?? defaultAgentFor(state);
  const fromName = options.fromName ?? "Reviewer";
  const actorAgentId = options.actorAgentId ?? task.reviewedByAgentId ?? task.reviewerAgentId ?? task.assignee;
  const now = Date.now();
  const conversation = ensureConversation(state, task.conversationId || DEFAULT_CONVERSATION.id);
  const event = recordTaskEvent(state, task, {
    type: "completed",
    actorAgentId,
    targetAgentId: ceo.id,
    summary: task.result || `Completed by ${fromName}`,
    result: task.result,
    reviewResult: task.reviewResult,
    artifactIds: task.artifactIds
  });
  if (actorAgentId === ceo.id) {
    conversation.updated_at = now;
    return;
  }
  updatePendingForTask(state, task, `等待 ${ceo.id} 总结...`);
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

function workflowSummaries(state: State): Array<{ id: string; name: string; defaultCoordinatorAgentId: string; agentIds: string[]; agents: Agent[] }> {
  return WORKFLOW_TEMPLATES.map((workflow) => workflowSummary(state, workflow));
}

function workflowSummary(state: State, workflow: WorkflowTemplate): { id: string; name: string; defaultCoordinatorAgentId: string; agentIds: string[]; agents: Agent[] } {
  const agentIds = workflowAgentIdsFor(state, workflow);
  return {
    id: workflow.id,
    name: workflow.name,
    defaultCoordinatorAgentId: workflow.defaultCoordinatorAgentId,
    agentIds,
    agents: agentIds.map((id) => findAgent(state, id)).filter((agent): agent is Agent => Boolean(agent))
  };
}

function isRuntimeVisibleMessage(message: Message): boolean {
  return message.status !== "pending";
}

function unreadMessagesFor(state: State, agentId: string): Message[] {
  return state.messages.filter((message) =>
    isRuntimeVisibleMessage(message) &&
    messageVisibleToAgentInConversation(state, message, agentId) &&
    (!message.to_agent_id || message.to_agent_id === agentId) &&
    !message.readBy.includes(agentId)
  );
}

function messageVisibleToAgentInConversation(state: State, message: Message, agentId: string): boolean {
  if (message.to_agent_id) return true;
  const conversation = state.conversations.find((row) => row.id === message.conversation_id);
  if (!conversation) return true;
  return teamAgentsFor(state, conversation).some((agent) => agent.id === agentId);
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

function normalizeRunContract(input: unknown): RunContract | undefined {
  if (!input || typeof input !== "object") return undefined;
  const row = input as Record<string, unknown>;
  const contract: RunContract = {
    agentId: normalizeAgentId(row.agentId),
    conversationId: typeof row.conversationId === "string" && row.conversationId.trim() ? row.conversationId.trim() : undefined,
    requestId: typeof row.requestId === "string" && row.requestId.trim() ? row.requestId.trim() : undefined,
    messageId: typeof row.messageId === "string" && row.messageId.trim() ? row.messageId.trim() : undefined,
    taskId: typeof row.taskId === "string" && row.taskId.trim() ? row.taskId.trim() : undefined
  };
  return Object.values(contract).some(Boolean) ? contract : undefined;
}

function resolveRunContract(state: State, runId?: string, inlineContract?: unknown): RunContract | undefined {
  const stored = runId ? state.activeRunContracts?.[runId] : undefined;
  const inline = normalizeRunContract(inlineContract);
  return stored ?? inline;
}

function pruneActiveRunContracts(contracts: Record<string, RunContract>): Record<string, RunContract> {
  return Object.fromEntries(Object.entries(contracts).slice(-100));
}

function pruneRunStreams(streams: Record<string, RunStreamState>): Record<string, RunStreamState> {
  return Object.fromEntries(Object.entries(streams).slice(-RUN_STREAM_CAPACITY));
}

function validateRunContractAction(state: State, contract: RunContract | undefined, actor: Agent, action: { command: "reply" | "task"; conversationId?: string; taskId?: string }): string | null {
  if (!contract) return null;
  if (contract.agentId && contract.agentId !== actor.id) return `run contract mismatch: actor ${actor.id} cannot act for ${contract.agentId}`;
  if (action.command === "reply" && contract.conversationId && action.conversationId && action.conversationId !== contract.conversationId) {
    return `run contract mismatch: reply conversation ${action.conversationId} does not match wake conversation ${contract.conversationId}`;
  }
  if (action.command === "task" && action.taskId) {
    const lookup = lookupTask(state, action.taskId);
    const task = lookup.task;
    if (contract.taskId && (!task || task.id !== contract.taskId)) {
      return `run contract mismatch: task ${action.taskId} does not match wake task ${contract.taskId}`;
    }
    if (task && contract.conversationId && task.conversationId && task.conversationId !== contract.conversationId) {
      return `run contract mismatch: task conversation ${task.conversationId} does not match wake conversation ${contract.conversationId}`;
    }
  }
  return null;
}

function recordRunAction(state: State, runId: string | undefined, contract: RunContract | undefined, actor: Agent, kind: RunAction["kind"], detail: { conversationId?: string; taskId?: string; summary?: string } = {}): void {
  if (!runId) return;
  const action: RunAction = {
    runId,
    agentId: actor.id,
    kind,
    conversationId: detail.conversationId ?? contract?.conversationId,
    requestId: contract?.requestId,
    messageId: contract?.messageId,
    taskId: detail.taskId ?? contract?.taskId,
    summary: detail.summary,
    at: Date.now()
  };
  state.runActions = pruneRunActions({ ...(state.runActions ?? {}), [runId]: [...(state.runActions?.[runId] ?? []), action] });
}

function pruneRunActions(actions: Record<string, RunAction[]>): Record<string, RunAction[]> {
  return Object.fromEntries(Object.entries(actions).slice(-100).map(([runId, rows]) => [runId, rows.slice(-50)]));
}

function clearRunStateForConversation(state: State, conversationId: string): void {
  const runIds = new Set<string>();
  for (const [runId, contract] of Object.entries(state.activeRunContracts ?? {})) {
    if (contract.conversationId === conversationId) runIds.add(runId);
  }
  for (const [runId, actions] of Object.entries(state.runActions ?? {})) {
    if (actions.some((action) => action.conversationId === conversationId)) runIds.add(runId);
  }
  if (!runIds.size) return;
  state.activeRunContracts = Object.fromEntries(Object.entries(state.activeRunContracts ?? {}).filter(([runId]) => !runIds.has(runId)));
  state.runActions = Object.fromEntries(Object.entries(state.runActions ?? {}).filter(([runId]) => !runIds.has(runId)));
  state.runStreams = Object.fromEntries(Object.entries(state.runStreams ?? {}).filter(([runId]) => !runIds.has(runId)));
}

function isTaskMutationCommand(args: string[]): boolean {
  return args[0] === "done" || args[0] === "update" || args[0] === "create";
}

function isCliUsageOrError(result: string): boolean {
  return /^(usage:|invalid |task not found:|task id required|ambiguous task id:)/i.test(result);
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

function updatePendingForTask(state: State, task: Task, body: string): void {
  const conversationId = task.conversationId || DEFAULT_CONVERSATION.id;
  const coordinator = findAgent(state, task.coordinatorAgentId) ?? defaultAgentFor(state);
  const pending = [...state.messages].reverse().find((message) =>
    message.conversation_id === conversationId &&
    message.author_kind === "agent" &&
    message.status === "pending" &&
    pendingBelongsToAgent(message, coordinator)
  );
  if (!pending) return;
  pending.body = body;
  pending.created_at = Date.now();
  pending.readBy = [coordinator.id];
}

function taskVisibleStatus(state: State, task: Task): TaskStatus | "blocked" {
  if (task.status === "done") return "done";
  const doneIds = state.tasks.filter((row) => row.status === "done").map((row) => row.id);
  const readiness = workflowReadiness(workflowCardFromTask(task), doneIds);
  return readiness.blockedBy.length > 0 ? "blocked" : task.status;
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

export type RunFeedbackSummary = {
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
  return findArtifactInState(state, id) as Artifact | undefined;
}

function artifactCandidateFromArgs(args: string[]): ReturnType<typeof artifactCandidateFromArgsHelper> {
  return artifactCandidateFromArgsHelper(args, readOption);
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
  if (!raw.trim()) throw new Error("usage: king-ai plan parse|apply '<json plan>'");
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
  if (!raw.trim()) throw new Error("usage: king-ai eval parse|record '<json evaluation>'");
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

export {
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
};
