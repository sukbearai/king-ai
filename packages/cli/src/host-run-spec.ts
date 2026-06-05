import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { hostRunHeartbeatPathForOutputDir } from "./host-run-heartbeat.js";
import { formatAttachmentPrompt, normalizeRuntimeAttachments, requiredAttachmentsRejected } from "./attachments.js";
import type { RuntimeAttachment } from "./attachments.js";
import type { EngineId } from "./types.js";

export type HostRunMode = "run" | "takeover";
export type HostRunLoopMode = "bounded" | "infinite";
export type HostRunRoleProfile = "small" | "engineering" | "product" | "full";
export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface ThreadSyncSpec {
  threadId: string;
  syncUrl?: string;
  syncSecret?: string;
}

export interface HostRunOptions {
  loops: number;
  pollIntervalSeconds: number;
  loopMode: HostRunLoopMode;
  engine?: EngineId;
  model?: string;
  fastModel?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  configPath?: string;
  workerUrl?: string;
  workerModel?: string;
  workerKey?: string;
  noBrain: boolean;
  keepArtifacts: boolean;
  outputDir: string;
  errorLimit: number;
}

export interface HostProjectRunSpec {
  goal: string;
  mode: HostRunMode;
  projectDir?: string;
  repoSourceDir?: string;
  repoCloneUrl?: string;
  workspaceRoot?: string;
  gitRoot?: string;
  sourceLabel: string;
  bootstrapScript?: string;
  githubToken?: string;
  threadSync?: ThreadSyncSpec;
  roleProfile: HostRunRoleProfile;
  hooks?: unknown;
  attachments: RuntimeAttachment[];
}

export type ProjectRunSpec<THooks = unknown> = Omit<Partial<HostProjectRunSpec>, "hooks"> & {
  hooks?: THooks;
};

export interface HostRunPlan {
  runId: string;
  spec: HostProjectRunSpec;
  options: HostRunOptions;
  summary: string;
}

export interface HostLaunchIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
}

export type HostRunLlmModeLabel = "hybrid-worker" | "codex-cli" | "claude-cli" | "runtime-default";

export interface HostRunSessionPlan {
  runId: string;
  sourceLabel: string;
  useHybrid: boolean;
  runtimeOverride?: EngineId;
  modelOverride?: string;
  fastModelOverride?: string;
  codexReasoningEffort?: CodexReasoningEffort;
  runtimeLabel: string;
  llmModeLabel: HostRunLlmModeLabel;
  codexConfigLabel: string | null;
}

export interface HostRunEnvironmentPlan {
  envFilePath?: string;
  envFileExists: boolean;
  envLoading: "not-loaded";
  note: string;
}

export interface HostRunGitPlan {
  gitRoot: string;
  isGitRepo: boolean;
  activeBranch?: string;
  hasUpstream: boolean;
  branchAhead: number;
  branchBehind: number;
  modifiedFiles: string[];
  prUrl?: string;
}

export interface HostRunConfigPlan {
  label: string;
  source: "explicit" | "project" | "default";
  path?: string;
  exists: boolean;
}

export interface HostRunLocalLayoutPlan {
  baseDir: string;
  configPath: string;
  workspaceRoot: string;
  sharedSkillsDir: string;
  gitRoot: string;
  outputDir: string;
  loopEventsPath: string;
  resultsPath: string;
  heartbeatPath: string;
  metaPath: string;
  collaborationPath: string;
  tasksPath: string;
  capsulesPath: string;
  workflowPath: string;
  feedbackPath: string;
  sourceConfigPath?: string;
  exists: boolean;
}

export interface HostLaunchPlan extends HostRunPlan {
  availableEngines: EngineId[];
  effectiveEngine?: EngineId;
  session: HostRunSessionPlan;
  environment: HostRunEnvironmentPlan;
  git: HostRunGitPlan;
  config: HostRunConfigPlan;
  layout: HostRunLocalLayoutPlan;
  ready: boolean;
  issues: HostLaunchIssue[];
  suggestedCommands: string[];
  launchSummary: string;
}

export type JsonSafeHostLaunchPlan = Omit<HostLaunchPlan, "options"> & {
  options: Omit<HostRunOptions, "loops"> & {
    loops: number | "infinite";
  };
};

export type HostRunSpecInput = Omit<Partial<HostProjectRunSpec>, "attachments"> & {
  goal: string;
  options?: Partial<HostRunOptions>;
  runId?: string;
  attachments?: unknown;
};

export function createDefaultHostRunOptions(overrides: Partial<HostRunOptions> = {}): HostRunOptions {
  const loopMode = overrides.loopMode ?? (overrides.loops === Infinity ? "infinite" : "bounded");
  return {
    loops: loopMode === "infinite" ? Infinity : Math.max(1, Math.floor(overrides.loops ?? 100)),
    pollIntervalSeconds: Math.max(1, Math.floor(overrides.pollIntervalSeconds ?? 15)),
    loopMode,
    engine: overrides.engine,
    model: cleanString(overrides.model),
    fastModel: cleanString(overrides.fastModel),
    codexReasoningEffort: normalizeReasoningEffort(overrides.codexReasoningEffort),
    configPath: cleanString(overrides.configPath),
    workerUrl: cleanString(overrides.workerUrl),
    workerModel: cleanString(overrides.workerModel),
    workerKey: cleanString(overrides.workerKey) ?? "lmstudio",
    noBrain: overrides.noBrain ?? false,
    keepArtifacts: overrides.keepArtifacts ?? false,
    outputDir: overrides.outputDir ? resolve(overrides.outputDir) : resolve("deliverables"),
    errorLimit: Math.max(1, Math.floor(overrides.errorLimit ?? 20))
  };
}

export function createHostRunPlan(input: HostRunSpecInput, env: NodeJS.ProcessEnv = process.env): HostRunPlan {
  const goal = cleanString(input.goal);
  if (!goal) throw new Error("goal is required");
  const mode = input.mode ?? "run";
  const projectDir = resolveOptionalDir(input.projectDir, "projectDir");
  const repoSourceDir = resolveOptionalDir(input.repoSourceDir ?? projectDir, "repoSourceDir");
  const workspaceRoot = input.workspaceRoot ? resolve(input.workspaceRoot) : env.KING_AGENT_WORKSPACE_ROOT;
  const gitRoot = input.gitRoot ? resolve(input.gitRoot) : repoSourceDir ?? projectDir;
  const options = createDefaultHostRunOptions(input.options);
  const explicitRunId = cleanString(input.runId);
  const spec: HostProjectRunSpec = {
    goal,
    mode,
    projectDir,
    repoSourceDir,
    repoCloneUrl: cleanString(input.repoCloneUrl),
    workspaceRoot: workspaceRoot ? resolve(workspaceRoot) : undefined,
    gitRoot,
    sourceLabel: cleanString(input.sourceLabel) || sourceLabel({ projectDir, repoSourceDir, repoCloneUrl: input.repoCloneUrl }),
    bootstrapScript: cleanString(input.bootstrapScript),
    githubToken: cleanString(input.githubToken),
    threadSync: normalizeThreadSync(input.threadSync),
    roleProfile: normalizeRoleProfile(input.roleProfile),
    hooks: input.hooks,
    attachments: normalizeRuntimeAttachments(input.attachments)
  };
  const rejectedRequired = requiredAttachmentsRejected(spec.attachments);
  if (rejectedRequired.length) {
    throw new Error(`required attachment rejected: ${rejectedRequired.map((attachment) => `${attachment.name} (${attachment.rejectionReason ?? attachment.decision})`).join(", ")}`);
  }
  return {
    runId: explicitRunId ? safeFilenameSegment(explicitRunId, "runId") : buildHostRunId(goal),
    spec,
    options,
    summary: formatHostRunPlanSummary({ spec, options })
  };
}

export function createHostLaunchPlan(
  input: HostRunSpecInput,
  env: NodeJS.ProcessEnv = process.env,
  availableEngines = detectAvailableHostEngines(env)
): HostLaunchPlan {
  const plan = createHostRunPlan(input, env);
  const issues: HostLaunchIssue[] = [];
  const effectiveEngine = plan.options.engine && availableEngines.includes(plan.options.engine)
    ? plan.options.engine
    : availableEngines[0];

  if (availableEngines.length === 0) {
    issues.push({
      severity: "error",
      code: "no-engine",
      message: "No supported local engine is available on PATH. Install and sign in to Claude Code or Codex."
    });
  } else if (plan.options.engine && !availableEngines.includes(plan.options.engine)) {
    issues.push({
      severity: "warning",
      code: "engine-unavailable",
      message: `${plan.options.engine} was requested but is not available; ${effectiveEngine ?? "the runtime default"} would be used instead.`
    });
  }

  if (plan.spec.mode === "takeover" && !plan.spec.projectDir && !plan.spec.repoSourceDir && !plan.spec.repoCloneUrl) {
    issues.push({
      severity: "error",
      code: "takeover-source-required",
      message: "Takeover mode requires projectDir, repoSourceDir, or repoCloneUrl."
    });
  }
  if (plan.spec.projectDir && !isGitRepo(plan.spec.projectDir)) {
    issues.push({
      severity: "warning",
      code: "project-not-git",
      message: "The selected project directory is not a git repository; worktree and patch planning will be limited."
    });
  }
  if (!plan.spec.workspaceRoot) {
    issues.push({
      severity: "info",
      code: "default-agent-workspace",
      message: "No explicit workspaceRoot was provided; agents will use their private workspace directories."
    });
  }

  const config = createHostRunConfigPlan(plan);
  const launchPlan: HostLaunchPlan = {
    ...plan,
    availableEngines,
    effectiveEngine,
    session: createHostRunSessionPlan(plan, effectiveEngine),
    environment: createHostRunEnvironmentPlan(plan),
    git: createHostRunGitPlan(plan),
    config,
    layout: createHostRunLocalLayoutPlan(plan, config),
    ready: !issues.some((issue) => issue.severity === "error"),
    issues,
    suggestedCommands: suggestedCommands(plan),
    launchSummary: ""
  };
  launchPlan.launchSummary = formatHostLaunchPlanSummary(launchPlan);
  return launchPlan;
}

export function formatHostRunPlanSummary(plan: Pick<HostRunPlan, "spec" | "options">): string {
  const lines = [
    `host run: ${plan.spec.mode} ${plan.spec.sourceLabel}`,
    `goal: ${plan.spec.goal}`,
    `engine: ${plan.options.engine ?? "runtime default"} model=${plan.options.model ?? "default"} fast=${plan.options.fastModel ?? "default"}`,
    `brain: ${plan.options.noBrain ? "disabled" : "enabled"} worker=${plan.options.workerUrl ? "configured" : "default"} workerModel=${plan.options.workerModel ?? "default"} config=${plan.options.configPath ? "configured" : "default"}`,
    `loops: ${plan.options.loopMode === "infinite" ? "infinite" : plan.options.loops} poll=${plan.options.pollIntervalSeconds}s errors=${plan.options.errorLimit}`,
    `output: ${plan.options.outputDir}`
  ];
  if (plan.spec.projectDir) lines.push(`project: ${plan.spec.projectDir}`);
  if (plan.spec.repoSourceDir && plan.spec.repoSourceDir !== plan.spec.projectDir) lines.push(`repo source: ${plan.spec.repoSourceDir}`);
  if (plan.spec.workspaceRoot) lines.push(`workspace root: ${plan.spec.workspaceRoot}`);
  if (plan.spec.gitRoot) lines.push(`git root: ${plan.spec.gitRoot}`);
  if (plan.spec.threadSync) lines.push(`thread sync: ${plan.spec.threadSync.threadId}`);
  const attachmentPrompt = formatAttachmentPrompt(plan.spec.attachments);
  if (attachmentPrompt) lines.push(attachmentPrompt);
  lines.push(`role profile: ${plan.spec.roleProfile}`);
  return lines.join("\n");
}

export function formatHostLaunchPlanSummary(plan: HostLaunchPlan): string {
  const lines = [
    plan.summary,
    `session: ${plan.session.llmModeLabel} runtime=${plan.session.runtimeLabel} codex=${plan.session.codexConfigLabel ?? "n/a"}`,
    `environment: ${plan.environment.envFileExists ? ".env present" : ".env absent"} loading=${plan.environment.envLoading}`,
    `git: ${formatHostRunGitPlan(plan.git)}`,
    `config: ${plan.config.label} source=${plan.config.source} exists=${plan.config.exists ? "yes" : "no"}`,
    `layout: ${plan.layout.baseDir} exists=${plan.layout.exists ? "yes" : "no"}`,
    `workspace: ${plan.layout.workspaceRoot}`,
    `ready: ${plan.ready ? "yes" : "no"}`,
    `available engines: ${plan.availableEngines.join(", ") || "(none)"}`,
    `effective engine: ${plan.effectiveEngine ?? "(none)"}`
  ];
  if (plan.issues.length) {
    lines.push("preflight:");
    for (const issue of plan.issues) lines.push(`  - ${issue.severity}/${issue.code}: ${issue.message}`);
  }
  if (plan.suggestedCommands.length) {
    lines.push("suggested commands:");
    for (const command of plan.suggestedCommands) lines.push(`  ${command}`);
  }
  return lines.join("\n");
}

export function createHostRunEnvironmentPlan(plan: HostRunPlan): HostRunEnvironmentPlan {
  const envFilePath = plan.spec.projectDir ? join(plan.spec.projectDir, ".env") : undefined;
  return {
    envFilePath,
    envFileExists: !!envFilePath && existsSync(envFilePath),
    envLoading: "not-loaded",
    note: "Project .env files are detected for app visibility but are not loaded by host preflight or layout preparation."
  };
}

export function createHostRunGitPlan(plan: HostRunPlan): HostRunGitPlan {
  const gitRoot = plan.spec.gitRoot ?? plan.spec.projectDir ?? process.cwd();
  if (!isGitRepo(gitRoot)) return emptyHostRunGitPlan(gitRoot, false);
  const parsed = readHostGitStatus(gitRoot);
  return {
    gitRoot,
    isGitRepo: true,
    ...parsed,
    prUrl: detectPullRequestUrl(gitRoot, parsed.activeBranch)
  };
}

export function parseHostGitStatus(raw: string): Omit<HostRunGitPlan, "gitRoot" | "isGitRepo" | "prUrl"> {
  const state: Omit<HostRunGitPlan, "gitRoot" | "isGitRepo" | "prUrl"> = {
    activeBranch: undefined,
    hasUpstream: false,
    branchAhead: 0,
    branchBehind: 0,
    modifiedFiles: []
  };
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const branch = line.slice("# branch.head ".length).trim();
      state.activeBranch = branch && branch !== "(detached)" ? branch : undefined;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      state.hasUpstream = true;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        state.branchAhead = Number.parseInt(match[1] ?? "0", 10);
        state.branchBehind = Number.parseInt(match[2] ?? "0", 10);
      }
      continue;
    }
    const file = parseHostGitStatusPath(line);
    if (file && !seen.has(file)) {
      seen.add(file);
      state.modifiedFiles.push(file);
    }
  }
  return state;
}

function readHostGitStatus(gitRoot: string): Omit<HostRunGitPlan, "gitRoot" | "isGitRepo" | "prUrl"> {
  try {
    return parseHostGitStatus(execFileSync("git", ["status", "--porcelain=v2", "--branch", "--untracked-files=all"], {
      cwd: gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    }));
  } catch {
    return emptyHostRunGitPlan(gitRoot, true);
  }
}

function parseHostGitStatusPath(line: string): string | undefined {
  if (line.startsWith("? ") || line.startsWith("! ")) return line.slice(2).trim() || undefined;
  const ordinary = line.match(/^1 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
  if (ordinary) return ordinary[1]?.trim() || undefined;
  const renamed = line.match(/^2 [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
  if (renamed) return renamed[1]?.split("\t")[0]?.trim() || undefined;
  const unmerged = line.match(/^u [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.+)$/);
  if (unmerged) return unmerged[1]?.trim() || undefined;
  return undefined;
}

function detectPullRequestUrl(gitRoot: string, branch?: string): string | undefined {
  if (!branch) return undefined;
  try {
    const raw = execFileSync("gh", ["pr", "list", "--head", branch, "--json", "url", "--limit", "1"], {
      cwd: gitRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    }).trim();
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Array<{ url?: unknown }>;
    return typeof parsed[0]?.url === "string" ? parsed[0].url : undefined;
  } catch {
    return undefined;
  }
}

function emptyHostRunGitPlan(gitRoot: string, isGitRepo: boolean): HostRunGitPlan {
  return {
    gitRoot,
    isGitRepo,
    hasUpstream: false,
    branchAhead: 0,
    branchBehind: 0,
    modifiedFiles: []
  };
}

function formatHostRunGitPlan(plan: HostRunGitPlan): string {
  if (!plan.isGitRepo) return `${plan.gitRoot} not-git`;
  const branch = plan.activeBranch ?? "detached";
  const upstream = plan.hasUpstream ? "upstream=yes" : "upstream=no";
  const pr = plan.prUrl ? ` pr=${plan.prUrl}` : "";
  return `${branch} ahead=${plan.branchAhead} behind=${plan.branchBehind} changed=${plan.modifiedFiles.length} ${upstream}${pr}`;
}

export function toJsonSafeHostLaunchPlan(plan: HostLaunchPlan): JsonSafeHostLaunchPlan {
  return {
    ...plan,
    options: {
      ...plan.options,
      loops: plan.options.loopMode === "infinite" ? "infinite" : plan.options.loops
    }
  };
}

export function createHostRunConfigPlan(plan: HostRunPlan): HostRunConfigPlan {
  if (plan.options.configPath) {
    const path = resolve(plan.options.configPath);
    return {
      label: basename(path),
      source: "explicit",
      path,
      exists: existsSync(path)
    };
  }

  if (plan.spec.projectDir) {
    const path = join(plan.spec.projectDir, "agents.json");
    return {
      label: "agents.json (project)",
      source: "project",
      path,
      exists: existsSync(path)
    };
  }

  return {
    label: "built-in-local-agents.json",
    source: "default",
    exists: true
  };
}

export function createHostRunLocalLayoutPlan(plan: HostRunPlan, config = createHostRunConfigPlan(plan)): HostRunLocalLayoutPlan {
  const outputDir = resolve(plan.options.outputDir);
  const baseDir = join(outputDir, ".king-local", plan.runId);
  return {
    baseDir,
    configPath: join(baseDir, "agents.json"),
    workspaceRoot: plan.spec.workspaceRoot ?? join(baseDir, "agents"),
    sharedSkillsDir: join(baseDir, "shared-skills"),
    gitRoot: plan.spec.gitRoot ?? plan.spec.projectDir ?? process.cwd(),
    outputDir,
    loopEventsPath: join(outputDir, "loop-events.ndjson"),
    resultsPath: join(outputDir, "results.tsv"),
    heartbeatPath: hostRunHeartbeatPathForOutputDir(outputDir),
    metaPath: join(outputDir, "meta.json"),
    collaborationPath: join(baseDir, "collaboration.json"),
    tasksPath: join(outputDir, "tasks.jsonl"),
    capsulesPath: join(outputDir, "capsules.jsonl"),
    workflowPath: join(outputDir, "workflow.jsonl"),
    feedbackPath: join(outputDir, "run-feedback.jsonl"),
    sourceConfigPath: config.path,
    exists: existsSync(baseDir)
  };
}

export function createHostRunSessionPlan(plan: HostRunPlan, effectiveEngine?: EngineId): HostRunSessionPlan {
  const runtimeOverride = plan.options.engine;
  const runtimeLabel = runtimeOverride ?? effectiveEngine ?? "runtime default";
  const useHybrid = !!plan.options.workerUrl;
  const llmModeLabel: HostRunLlmModeLabel = useHybrid
    ? "hybrid-worker"
    : runtimeLabel === "codex"
      ? "codex-cli"
      : runtimeLabel === "claude"
        ? "claude-cli"
        : "runtime-default";
  const shouldShowCodexConfig = runtimeLabel === "codex" || runtimeOverride === "codex";
  return {
    runId: plan.runId,
    sourceLabel: plan.spec.sourceLabel,
    useHybrid,
    runtimeOverride,
    modelOverride: plan.options.model,
    fastModelOverride: plan.options.fastModel,
    codexReasoningEffort: plan.options.codexReasoningEffort,
    runtimeLabel,
    llmModeLabel,
    codexConfigLabel: shouldShowCodexConfig
      ? `${plan.options.model ?? "default"} / ${plan.options.codexReasoningEffort ?? "default"}`
      : null
  };
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeRoleProfile(value: unknown): HostRunRoleProfile {
  if (value === "small" || value === "engineering" || value === "product" || value === "full") return value;
  if (value === undefined || value === null || value === "") return "full";
  throw new Error(`invalid role profile: ${String(value)}`);
}

function safeFilenameSegment(value: string, label: string): string {
  if (value === "." || value === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe filename segment`);
  }
  return value;
}

function normalizeReasoningEffort(value: unknown): CodexReasoningEffort | undefined {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" ? value : undefined;
}

function normalizeThreadSync(value: HostProjectRunSpec["threadSync"]): HostProjectRunSpec["threadSync"] {
  if (!value?.threadId?.trim()) return undefined;
  return {
    threadId: value.threadId.trim(),
    syncUrl: cleanString(value.syncUrl),
    syncSecret: cleanString(value.syncSecret)
  };
}

function resolveOptionalDir(value: unknown, label: string): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const resolved = resolve(cleaned);
  if (!existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

export function detectAvailableHostEngines(env: NodeJS.ProcessEnv = process.env): EngineId[] {
  const engines: EngineId[] = [];
  if (commandExists("claude", env)) engines.push("claude");
  if (commandExists("codex", env)) engines.push("codex");
  return engines;
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      env,
      stdio: "ignore",
      timeout: 3000
    });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, ".git"));
}

function suggestedCommands(plan: HostRunPlan): string[] {
  const commands = ["king agent computer --doctor"];
  if (plan.spec.projectDir) commands.push(`king project-profile ${shellQuote(plan.spec.projectDir)}`);
  commands.push("king host status --json");
  return commands;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function sourceLabel(input: { projectDir?: string; repoSourceDir?: string; repoCloneUrl?: string }): string {
  if (input.projectDir) return `project:${input.projectDir.split(/[\\/]/).pop() ?? "local"}`;
  if (input.repoSourceDir) return `repo:${input.repoSourceDir.split(/[\\/]/).pop() ?? "local"}`;
  if (input.repoCloneUrl) return "remote-repo";
  return "ad-hoc";
}

function buildHostRunId(goal: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = goal.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).toLowerCase() || "goal";
  return `host-run-${ts}-${slug}`;
}
