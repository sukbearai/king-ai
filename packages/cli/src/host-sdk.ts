import type { HostStatusSnapshot } from "./host-api.js";
import type { HostCommandDefinition, HostCommandRequest, HostCommandResult } from "./host-control.js";
import type { DoctorResult } from "./daemon.js";
import type { HostExportInput, HostExportPlan, HostExportResult } from "./host-export.js";
import type { HostLoopEvent, HostLoopEventsInput, HostLoopEventsResult, HostLoopResultsInput, HostLoopResultsTable } from "./host-loop-events.js";
import type { HostRunExecuteResult } from "./host-run-executor.js";
import type { HostRunHeartbeatReadInput, HostRunHeartbeatReadResult } from "./host-run-heartbeat.js";
import type { HostRunMetaReadInput, HostRunMetaReadResult } from "./host-run-meta.js";
import type { HostRunLayoutResult } from "./host-run-layout.js";
import type { HostPolicyCheck } from "./host-policy.js";
import type { HostRunSpecInput, JsonSafeHostLaunchPlan, ProjectRunSpec, ThreadSyncSpec } from "./host-run-spec.js";
import type { HostRunRequest, HostRunRequestStatus, HostRunSubmitInput, HostRunSubmitResult, HostRunUpdateResult } from "./host-runs.js";
import type { HostTimelineEvent } from "./host-timeline.js";
import { DEFAULT_SSE_MAX_BUFFER_BYTES } from "./sse.js";
import type { EngineId } from "./types.js";
import type { UsageExpenseRow, UsageSummary } from "./usage.js";

export interface HostSdkOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type HostSdkEnvLike = Partial<Record<string, string | undefined>>;

export interface KingHostSdkConfig extends HostSdkOptions {
  env?: HostSdkEnvLike;
}

export interface HostSdkEnvOptions extends Omit<HostSdkOptions, "baseUrl"> {
  env?: HostSdkEnvLike;
}

export interface HostSdkLocationLike {
  protocol: string;
  hostname: string;
  port?: string;
  origin?: string;
}

export interface HostSdkBrowserOptions extends HostSdkOptions {
  location?: HostSdkLocationLike;
  port?: number | string;
  useCurrentOrigin?: boolean;
}

export interface HostSdkWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  requireDaemon?: boolean;
}

export interface HostSdkWaitForRunOptions {
  timeoutMs?: number;
  intervalMs?: number;
  terminalStatuses?: HostRunRequestStatus[];
}

export interface HostSdkStatusStreamOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface HostSdkTimelineStreamOptions {
  intervalMs?: number;
  limit?: number;
  signal?: AbortSignal;
}

export interface HostSdkRunRequestsStreamOptions {
  intervalMs?: number;
  limit?: number;
  status?: HostRunRequestStatus;
  signal?: AbortSignal;
}

export interface HostSdkRunRequestStreamOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

export interface HostSdkRunEventsOptions extends Omit<HostLoopEventsInput, "id"> {}
export interface HostSdkRunEventEmitInput extends HostLoopEvent {
  payload?: unknown;
}
export interface HostSdkRunResultsOptions extends Omit<HostLoopResultsInput, "id"> {}
export interface HostSdkRunHeartbeatOptions extends Omit<HostRunHeartbeatReadInput, "id"> {}
export interface HostSdkRunMetaOptions extends Omit<HostRunMetaReadInput, "id"> {}

export interface HostSdkRunStateFrame {
  request: HostRunRequest | null;
  heartbeat: HostRunHeartbeatReadResult["heartbeat"];
  meta: HostRunMetaReadResult["meta"];
}

export interface HostSdkHostStreamOptions {
  intervalMs?: number;
  limit?: number;
  timelineLimit?: number;
  runLimit?: number;
  status?: HostRunRequestStatus;
  signal?: AbortSignal;
}

export interface HostSdkWatchOptions extends HostSdkHostStreamOptions {
  includeInitialSnapshot?: boolean;
}

export type HostSdkStreamFrame =
  | { event: "status"; data: HostStatusSnapshot }
  | { event: "timeline"; data: HostTimelineEvent[] }
  | { event: "runs"; data: HostRunRequest[] };

export type HostSdkWatchFrame =
  | { event: "snapshot"; data: HostSnapshotResponse }
  | HostSdkStreamFrame;

export interface HostSdkRunOptions {
  loops?: number;
  pollInterval?: number;
  pollIntervalSeconds?: number;
  infinite?: boolean;
  runtime?: EngineId;
  engine?: EngineId;
  codexModel?: string;
  model?: string;
  fastModel?: string;
  codexReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  configPath?: string;
  workerUrl?: string;
  workerModel?: string;
  workerKey?: string;
  noBrain?: boolean;
  enableBrain?: boolean;
  projectDir?: string;
  repoSourceDir?: string;
  repoCloneUrl?: string;
  workspaceRoot?: string;
  gitRoot?: string;
  outputDir?: string;
  output?: string;
  keepArtifacts?: boolean;
  keep?: boolean;
  errorLimit?: number;
}

export interface HostSdkTakeoverOptions extends HostSdkRunOptions {
  projectPath?: string;
  goalOverride?: string;
}

export type RunOptions = HostSdkRunOptions;
export type { ProjectRunSpec, ThreadSyncSpec };
export type KingHostRunOptions = HostSdkRunOptions;
export type KingHostRunInvocation = HostSdkRunOptions;
export type KingHostTakeoverOptions = HostSdkTakeoverOptions;

export interface KingHostSdkBindings {
  hostEnv: HostSdkEnvLike;
}

export interface KingHostSdkAdapters<
  TProjectRunSpec,
  TPreparedTakeoverPlan,
  TConcreteTakeoverOptions extends object
> {
  runGoal(
    goal: string,
    options: HostSdkRunOptions,
    spec: TProjectRunSpec,
    bindings: KingHostSdkBindings
  ): Promise<void>;
  prepareTakeoverPlan(options: TConcreteTakeoverOptions): TPreparedTakeoverPlan;
  executePreparedTakeoverPlan(
    plan: TPreparedTakeoverPlan,
    options: HostSdkRunOptions,
    bindings: KingHostSdkBindings
  ): Promise<void>;
  normalizeTakeoverOptions(
    options: TConcreteTakeoverOptions | KingHostTakeoverOptions
  ): TConcreteTakeoverOptions;
}

export interface HostHealth {
  ok: boolean;
  service: string;
  readOnly: boolean;
  commands: string[];
}

export interface HostCommandsResponse {
  ok: boolean;
  commands: HostCommandDefinition[];
}

export interface HostCapabilitiesResponse extends HostCommandsResponse {
  service: string;
  readOnly: boolean;
  localhostOnly: boolean;
  cors?: {
    enabled: boolean;
    allowedOrigins: string[];
  };
  resources: string[];
  streams: string[];
  safeExecutorCommands: string[];
  destructiveCommands: string[];
  commandEnvelope: {
    path: string;
    method: string;
  };
}

export interface HostEventsResponse {
  ok: boolean;
  events: HostStatusSnapshot["events"];
}

export interface HostTimelineResponse {
  events: HostTimelineEvent[];
}

export interface HostSnapshotResponse {
  ok: boolean;
  status: HostStatusSnapshot;
  capabilities: HostCapabilitiesResponse;
  timeline: HostTimelineEvent[];
  runs: HostRunRequest[];
}

export interface HostDoctorResponse {
  results: DoctorResult[];
  exitCode: number;
}

export interface HostExpensesResponse {
  expenses: UsageExpenseRow[];
  usage: UsageSummary;
}

export interface HostRunRequestsResponse {
  requests: HostRunRequest[];
}

export interface HostRunRequestResponse {
  request: HostRunRequest;
}

export interface HostSdkPrepareRunLayoutInput extends HostRunSpecInput {
  force?: boolean;
  confirmed?: boolean;
  confirmation?: string;
}

export interface HostSdkSubmitAndExecuteResult {
  submitted: HostCommandResult & { json?: HostRunSubmitResult };
  executed: HostCommandResult & { json?: HostRunExecuteResult };
}

export interface HostSdkPreparedTakeover {
  options: HostSdkTakeoverOptions;
  runOptions: HostSdkRunOptions;
  input: HostRunSpecInput;
  preflight: HostCommandResult & { json?: JsonSafeHostLaunchPlan };
}

export interface HostSdkSubmitAndWatchOptions extends HostSdkRunRequestStreamOptions {
  terminalStatuses?: HostRunRequestStatus[];
}

export type HostSdkSubmitAndWatchFrame =
  | { event: "submitted"; data: HostCommandResult & { json?: HostRunSubmitResult } }
  | { event: "run"; data: HostRunRequest | null };

export type HostSdkSubmitAndWatchStateFrame =
  | { event: "submitted"; data: HostCommandResult & { json?: HostRunSubmitResult } }
  | { event: "state"; data: HostSdkRunStateFrame };

type HostSdkReadableBody =
  | AsyncIterable<Uint8Array>
  | {
    getReader: () => {
      read: () => Promise<{ done?: boolean; value?: Uint8Array }>;
      releaseLock?: () => void;
    };
  };

export type HostSdk = ReturnType<typeof createHostSdk>;
export interface KingAdapterHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TTakeoverInvocation = KingHostTakeoverOptions
> {
  run(goal: string, options?: KingHostRunInvocation, spec?: TProjectRunSpec): Promise<void>;
  prepareTakeover(options: TTakeoverInvocation): TPreparedTakeoverPlan;
  executePreparedTakeover(plan: TPreparedTakeoverPlan, options?: KingHostRunInvocation): Promise<void>;
  takeover(options: TTakeoverInvocation, runOptions?: KingHostRunInvocation): Promise<void>;
}

export type KingHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TTakeoverInvocation = KingHostTakeoverOptions
> = HostSdk | KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TTakeoverInvocation>;

export function createDefaultHostSdkRunOptions(overrides: HostSdkRunOptions = {}): HostSdkRunOptions {
  const infinite = overrides.infinite ?? overrides.loops === Infinity;
  return {
    ...overrides,
    loops: infinite ? Infinity : Math.max(1, Math.floor(overrides.loops ?? 100)),
    pollIntervalSeconds: Math.max(1, Math.floor(overrides.pollIntervalSeconds ?? overrides.pollInterval ?? 15)),
    infinite,
    engine: overrides.engine ?? overrides.runtime,
    model: cleanSdkString(overrides.model ?? overrides.codexModel),
    fastModel: cleanSdkString(overrides.fastModel),
    configPath: cleanSdkString(overrides.configPath),
    workerUrl: cleanSdkString(overrides.workerUrl),
    workerModel: cleanSdkString(overrides.workerModel),
    workerKey: cleanSdkString(overrides.workerKey) ?? "lmstudio",
    noBrain: overrides.noBrain ?? (overrides.enableBrain === undefined ? false : !overrides.enableBrain),
    outputDir: cleanSdkString(overrides.outputDir ?? overrides.output) ?? "./deliverables",
    keepArtifacts: overrides.keepArtifacts ?? overrides.keep ?? false,
    errorLimit: Math.max(1, Math.floor(overrides.errorLimit ?? 20))
  };
}

export function createHostSdkRunOptions(overrides: HostSdkRunOptions = {}): HostSdkRunOptions {
  return createDefaultHostSdkRunOptions(overrides);
}

export function createHostSdkTakeoverRunOptions(overrides: HostSdkRunOptions = {}): HostSdkRunOptions {
  return createDefaultHostSdkRunOptions({
    infinite: true,
    loops: Infinity,
    ...overrides
  });
}

export const createDefaultRunOptions = createDefaultHostSdkRunOptions;
export const createRunOptions = createHostSdkRunOptions;
export const createTakeoverRunOptions = createHostSdkTakeoverRunOptions;

export function createHostSdk(options: HostSdkOptions = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://127.0.0.1:8799");
  const fetchImpl = options.fetch ?? fetch;
  return {
    health: () => getJson<HostHealth>(fetchImpl, baseUrl, "/health"),
    status: () => getJson<HostStatusSnapshot>(fetchImpl, baseUrl, "/status"),
    statusStream: (streamOptions?: HostSdkStatusStreamOptions) => streamHostStatus(fetchImpl, baseUrl, streamOptions),
    events: () => getJson<HostEventsResponse>(fetchImpl, baseUrl, "/events"),
    usage: () => getJson<HostCommandResult & { json?: UsageSummary }>(fetchImpl, baseUrl, "/usage"),
    expenses: () => getJson<HostCommandResult & { json?: HostExpensesResponse }>(fetchImpl, baseUrl, "/expenses"),
    doctor: () => getJson<HostCommandResult & { json?: HostDoctorResponse }>(fetchImpl, baseUrl, "/doctor"),
    commands: () => getJson<HostCommandsResponse>(fetchImpl, baseUrl, "/commands"),
    capabilities: () => getJson<HostCapabilitiesResponse>(fetchImpl, baseUrl, "/capabilities"),
    snapshot: (limit = 20, status?: HostRunRequestStatus) => getJson<HostSnapshotResponse>(fetchImpl, baseUrl, pathWithQuery("/host/snapshot", { limit, status })),
    waitForReady: (waitOptions?: HostSdkWaitOptions) => waitForHostReady(fetchImpl, baseUrl, waitOptions),
    watch: (watchOptions?: HostSdkWatchOptions) => watchHost(fetchImpl, baseUrl, watchOptions),
    hostStream: (streamOptions?: HostSdkHostStreamOptions) => streamHostFrames(fetchImpl, baseUrl, streamOptions),
    timelineStream: (streamOptions?: HostSdkTimelineStreamOptions) => streamHostTimeline(fetchImpl, baseUrl, streamOptions),
    run: (goal: string, options: HostSdkRunOptions = {}, spec: Partial<HostRunSpecInput> = {}) => {
      return postJson<HostCommandResult & { json?: JsonSafeHostLaunchPlan }>(fetchImpl, baseUrl, "/runs/preflight", hostRunSpecFromSdk(goal, createHostSdkRunOptions(options), spec, "run"));
    },
    runAndWatch: (goal: string, options: HostSdkRunOptions = {}, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      return submitAndWatchHostRun(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, createHostSdkRunOptions(options), spec, "run"), watchOptions);
    },
    runAndWatchState: (goal: string, options: HostSdkRunOptions = {}, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      return submitAndWatchHostRunState(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, createHostSdkRunOptions(options), spec, "run"), watchOptions);
    },
    takeover: async (options: HostSdkTakeoverOptions, runOptions: HostSdkRunOptions = {}) => (await prepareHostSdkTakeover(fetchImpl, baseUrl, options, runOptions)).preflight,
    prepareTakeover: (options: HostSdkTakeoverOptions, runOptions: HostSdkRunOptions = {}) => prepareHostSdkTakeover(fetchImpl, baseUrl, options, runOptions),
    executePreparedTakeover: (prepared: HostSdkPreparedTakeover, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      const goal = prepared.input.goal;
      return submitAndWatchHostRun(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, prepared.runOptions, {
        ...prepared.input,
        ...spec,
        options: {
          ...prepared.input.options,
          ...spec.options
        }
      }, "takeover"), watchOptions);
    },
    executePreparedTakeoverState: (prepared: HostSdkPreparedTakeover, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      const goal = prepared.input.goal;
      return submitAndWatchHostRunState(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, prepared.runOptions, {
        ...prepared.input,
        ...spec,
        options: {
          ...prepared.input.options,
          ...spec.options
        }
      }, "takeover"), watchOptions);
    },
    takeoverAndWatch: (options: HostSdkTakeoverOptions, runOptions: HostSdkRunOptions = {}, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      const merged = { ...runOptions, ...options };
      const goal = options.goalOverride ?? `Take over ${options.projectPath ?? options.projectDir ?? options.repoSourceDir ?? "project"}`;
      return submitAndWatchHostRun(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, createHostSdkTakeoverRunOptions({
          ...merged,
          projectDir: options.projectPath ?? merged.projectDir
        }), spec, "takeover"), watchOptions);
    },
    takeoverAndWatchState: (options: HostSdkTakeoverOptions, runOptions: HostSdkRunOptions = {}, spec: Partial<HostRunSubmitInput> = {}, watchOptions?: HostSdkSubmitAndWatchOptions) => {
      const merged = { ...runOptions, ...options };
      const goal = options.goalOverride ?? `Take over ${options.projectPath ?? options.projectDir ?? options.repoSourceDir ?? "project"}`;
      return submitAndWatchHostRunState(fetchImpl, baseUrl, hostRunSubmitInputFromSdk(goal, createHostSdkTakeoverRunOptions({
          ...merged,
          projectDir: options.projectPath ?? merged.projectDir
        }), spec, "takeover"), watchOptions);
    },
    runCommand: <TJson = unknown>(request: HostCommandRequest) => runHostSdkCommand<TJson>(fetchImpl, baseUrl, request),
    planRun: (input: HostRunSpecInput) => postJson<HostCommandResult & { json?: JsonSafeHostLaunchPlan }>(fetchImpl, baseUrl, "/runs/plan", input),
    preflight: (input: HostRunSpecInput) => postJson<HostCommandResult & { json?: JsonSafeHostLaunchPlan }>(fetchImpl, baseUrl, "/runs/preflight", input),
    prepareRunLayout: (input: HostSdkPrepareRunLayoutInput) => postJson<HostCommandResult & { json?: HostRunLayoutResult }>(fetchImpl, baseUrl, "/runs/prepare-layout", input),
    submitRun: (input: HostRunSubmitInput) => postJson<HostCommandResult & { json?: HostRunSubmitResult }>(fetchImpl, baseUrl, "/runs", input),
    submitAndExecuteRun: (input: HostRunSubmitInput) => submitAndExecuteHostRun(fetchImpl, baseUrl, input),
    submitAndWatchRun: (input: HostRunSubmitInput, watchOptions?: HostSdkSubmitAndWatchOptions) => submitAndWatchHostRun(fetchImpl, baseUrl, input, watchOptions),
    submitAndWatchRunState: (input: HostRunSubmitInput, watchOptions?: HostSdkSubmitAndWatchOptions) => submitAndWatchHostRunState(fetchImpl, baseUrl, input, watchOptions),
    runRequests: (limit = 20, status?: HostRunRequestStatus) => getJson<HostCommandResult & { json?: HostRunRequestsResponse }>(fetchImpl, baseUrl, pathWithQuery("/runs", { limit, status })),
    runRequestsStream: (streamOptions?: HostSdkRunRequestsStreamOptions) => streamHostRunRequests(fetchImpl, baseUrl, streamOptions),
    runRequest: (id: string) => getJson<HostCommandResult & { json?: HostRunRequestResponse }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`),
    runRequestStream: (id: string, streamOptions?: HostSdkRunRequestStreamOptions) => streamHostRunRequest(fetchImpl, baseUrl, id, streamOptions),
    runStateStream: (id: string, streamOptions?: HostSdkRunRequestStreamOptions) => streamHostRunState(fetchImpl, baseUrl, id, streamOptions),
    emitRunEvent: (id: string, event: HostSdkRunEventEmitInput) => postJson<HostCommandResult & { json?: { file: string; event: HostLoopEvent } }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}/events`, { event }),
    runEvents: (id: string, eventsOptions: HostSdkRunEventsOptions = {}) => getJson<HostCommandResult & { json?: HostLoopEventsResult }>(fetchImpl, baseUrl, pathWithQuery(`/runs/${encodeURIComponent(id)}/events`, eventsOptions)),
    watchRun: (id: string, eventsOptions: HostSdkRunEventsOptions = {}) => getJson<HostCommandResult & { json?: HostLoopEventsResult }>(fetchImpl, baseUrl, pathWithQuery(`/runs/${encodeURIComponent(id)}/events`, eventsOptions)),
    runResults: (id: string, resultsOptions: HostSdkRunResultsOptions = {}) => getJson<HostCommandResult & { json?: HostLoopResultsTable }>(fetchImpl, baseUrl, pathWithQuery(`/runs/${encodeURIComponent(id)}/results`, resultsOptions)),
    runHeartbeat: (id: string, heartbeatOptions: HostSdkRunHeartbeatOptions = {}) => getJson<HostCommandResult & { json?: HostRunHeartbeatReadResult }>(fetchImpl, baseUrl, pathWithQuery(`/runs/${encodeURIComponent(id)}/heartbeat`, heartbeatOptions)),
    runMeta: (id: string, metaOptions: HostSdkRunMetaOptions = {}) => getJson<HostCommandResult & { json?: HostRunMetaReadResult }>(fetchImpl, baseUrl, pathWithQuery(`/runs/${encodeURIComponent(id)}/meta`, metaOptions)),
    waitForRun: (id: string, waitOptions?: HostSdkWaitForRunOptions) => waitForHostRun(fetchImpl, baseUrl, id, waitOptions),
    updateRun: (id: string, status: Exclude<HostRunRequestStatus, "pending">, detail?: string) => patchJson<HostCommandResult & { json?: HostRunUpdateResult }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`, { status, detail }),
    completeRun: (id: string, detail?: string) => patchJson<HostCommandResult & { json?: HostRunUpdateResult }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`, { status: "completed", detail }),
    failRun: (id: string, detail?: string) => patchJson<HostCommandResult & { json?: HostRunUpdateResult }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`, { status: "failed", detail }),
    cancelRun: (id: string, detail?: string) => deleteJson<HostCommandResult & { json?: HostRunUpdateResult }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`, { detail }),
    executeRun: (id?: string) => postJson<HostCommandResult & { json?: HostRunExecuteResult }>(fetchImpl, baseUrl, id ? `/runs/${encodeURIComponent(id)}/execute` : "/runs/execute", {}),
    planExport: (input: HostExportInput) => postJson<HostCommandResult & { json?: HostExportPlan }>(fetchImpl, baseUrl, "/exports/plan", input),
    exportArtifacts: (input: HostExportInput & { confirmed?: boolean; confirmation?: string }) => postJson<HostCommandResult & { json?: HostExportResult }>(fetchImpl, baseUrl, "/exports", input),
    policy: (command: string, input: { confirmed?: boolean; confirmation?: string } = {}) => {
      const path = `/policy/${encodeURIComponent(command)}`;
      return input.confirmed !== undefined || input.confirmation !== undefined
        ? postJson<HostCommandResult & { json?: HostPolicyCheck }>(fetchImpl, baseUrl, path, input)
        : getJson<HostCommandResult & { json?: HostPolicyCheck }>(fetchImpl, baseUrl, path);
    },
    timeline: (limit = 20) => getJson<HostCommandResult & { json?: HostTimelineResponse }>(fetchImpl, baseUrl, pathWithQuery("/timeline", { limit }))
  };
}

export function createKingHostSdk(config?: HostSdkOptions): HostSdk;
export function createKingHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TConcreteTakeoverOptions extends object = KingHostTakeoverOptions
>(
  config: KingHostSdkConfig,
  adapters: KingHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions>
): KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions | KingHostTakeoverOptions>;
export function createKingHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TConcreteTakeoverOptions extends object = KingHostTakeoverOptions
>(
  config: KingHostSdkConfig = {},
  adapters?: KingHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions>
): HostSdk | KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions | KingHostTakeoverOptions> {
  if (!adapters) return createHostSdk(config);
  const bindings: KingHostSdkBindings = {
    hostEnv: {
      ...process.env,
      ...(config.env ?? {})
    }
  };
  const sdk: KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions | KingHostTakeoverOptions> = {
    async run(goal, options = {}, spec = {} as TProjectRunSpec) {
      await adapters.runGoal(goal, createRunOptions(options), spec, bindings);
    },
    prepareTakeover(options) {
      return adapters.prepareTakeoverPlan(adapters.normalizeTakeoverOptions(options));
    },
    async executePreparedTakeover(plan, options = {}) {
      await adapters.executePreparedTakeoverPlan(plan, createTakeoverRunOptions(options), bindings);
    },
    async takeover(options, runOptions = {}) {
      const plan = sdk.prepareTakeover(options);
      await sdk.executePreparedTakeover(plan, runOptions);
    }
  };
  return sdk;
}

export function createEnvBackedHostSdk(env: HostSdkEnvLike = process.env, options: Omit<HostSdkOptions, "baseUrl"> = {}): HostSdk {
  return createHostSdk({
    ...options,
    baseUrl: hostBaseUrlFromEnv(env)
  });
}

export function createEnvBackedKingHostSdk(env?: HostSdkEnvLike, options?: Omit<HostSdkOptions, "baseUrl">): HostSdk;
export function createEnvBackedKingHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TConcreteTakeoverOptions extends object = KingHostTakeoverOptions
>(
  env: HostSdkEnvLike,
  config: Omit<KingHostSdkConfig, "env">,
  adapters: KingHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions>
): KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions | KingHostTakeoverOptions>;
export function createEnvBackedKingHostSdk<
  TProjectRunSpec = unknown,
  TPreparedTakeoverPlan = unknown,
  TConcreteTakeoverOptions extends object = KingHostTakeoverOptions
>(
  env: HostSdkEnvLike = process.env,
  config: Omit<KingHostSdkConfig, "env"> = {},
  adapters?: KingHostSdkAdapters<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions>
): HostSdk | KingAdapterHostSdk<TProjectRunSpec, TPreparedTakeoverPlan, TConcreteTakeoverOptions | KingHostTakeoverOptions> {
  if (!adapters) return createEnvBackedHostSdk(env, config);
  return createKingHostSdk({ ...config, env }, adapters);
}

export function createBrowserHostSdk(options: HostSdkBrowserOptions = {}): HostSdk {
  return createHostSdk({
    ...options,
    baseUrl: options.baseUrl ?? hostBaseUrlFromLocation(options.location ?? globalLocationLike(), options)
  });
}

export function hostBaseUrlFromEnv(env: HostSdkEnvLike = process.env): string {
  if (env.KING_AI_HOST_URL) return env.KING_AI_HOST_URL;
  const host = env.KING_AI_HOST || "127.0.0.1";
  const port = env.KING_AI_HOST_PORT || "8799";
  return `http://${host}:${port}`;
}

export function hostBaseUrlFromLocation(location: HostSdkLocationLike | undefined, options: { port?: number | string; useCurrentOrigin?: boolean } = {}): string {
  if (options.useCurrentOrigin && location?.origin) return location.origin;
  const port = options.port ?? location?.port ?? "8799";
  const hostname = location && isLocalHostName(location.hostname) ? location.hostname : "127.0.0.1";
  const protocol = location?.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${hostname}${port ? `:${port}` : ""}`;
}

export async function waitForHostReady(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkWaitOptions = {}
): Promise<HostStatusSnapshot> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 10_000));
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 250));
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      const health = await getJson<HostHealth>(fetchImpl, baseUrl, "/health");
      if (health.ok) {
        const status = await getJson<HostStatusSnapshot>(fetchImpl, baseUrl, "/status");
        if (!options.requireDaemon || status.ok) return status;
        lastError = new Error("host server is reachable but daemon state is not ready");
      }
    } catch (err) {
      lastError = err;
    }
    await delay(intervalMs);
  }

  const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`host server did not become ready within ${timeoutMs}ms${reason}`);
}

export async function waitForHostRun(
  fetchImpl: typeof fetch,
  baseUrl: string,
  id: string,
  options: HostSdkWaitForRunOptions = {}
): Promise<HostCommandResult & { json?: HostRunRequestResponse }> {
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000));
  const intervalMs = Math.max(1, Math.floor(options.intervalMs ?? 250));
  const terminals = new Set<HostRunRequestStatus>(options.terminalStatuses ?? ["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeoutMs;
  let last: HostCommandResult & { json?: HostRunRequestResponse } | undefined;

  while (Date.now() <= deadline) {
    last = await getJson<HostCommandResult & { json?: HostRunRequestResponse }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}`);
    const status = last.json?.request.status;
    if (status && terminals.has(status)) return last;
    await delay(intervalMs);
  }

  const status = last?.json?.request.status;
  throw new Error(`host run ${id} did not reach a terminal status within ${timeoutMs}ms${status ? `; last status=${status}` : ""}`);
}

export async function submitAndExecuteHostRun(
  fetchImpl: typeof fetch,
  baseUrl: string,
  input: HostRunSubmitInput
): Promise<HostSdkSubmitAndExecuteResult> {
  const submitted = await postJson<HostCommandResult & { json?: HostRunSubmitResult }>(fetchImpl, baseUrl, "/runs", input);
  const id = submitted.json?.request.id;
  if (!submitted.ok || !id) {
    return {
      submitted,
      executed: {
        ok: false,
        command: "execute-run",
        exitCode: 1,
        text: "host run was not submitted",
        error: submitted.error ?? "host run was not submitted"
      }
    };
  }
  const executed = await postJson<HostCommandResult & { json?: HostRunExecuteResult }>(fetchImpl, baseUrl, `/runs/${encodeURIComponent(id)}/execute`, {});
  return { submitted, executed };
}

export async function* submitAndWatchHostRun(
  fetchImpl: typeof fetch,
  baseUrl: string,
  input: HostRunSubmitInput,
  options: HostSdkSubmitAndWatchOptions = {}
): AsyncGenerator<HostSdkSubmitAndWatchFrame> {
  const submitted = await postJson<HostCommandResult & { json?: HostRunSubmitResult }>(fetchImpl, baseUrl, "/runs", input);
  yield { event: "submitted", data: submitted };
  const id = submitted.json?.request.id;
  if (!submitted.ok || !id) return;
  const terminalStatuses = new Set<HostRunRequestStatus>(options.terminalStatuses ?? ["completed", "failed", "cancelled"]);
  for await (const request of streamHostRunRequest(fetchImpl, baseUrl, id, options)) {
    yield { event: "run", data: request };
    if (request && terminalStatuses.has(request.status)) return;
  }
}

export async function* submitAndWatchHostRunState(
  fetchImpl: typeof fetch,
  baseUrl: string,
  input: HostRunSubmitInput,
  options: HostSdkSubmitAndWatchOptions = {}
): AsyncGenerator<HostSdkSubmitAndWatchStateFrame> {
  const submitted = await postJson<HostCommandResult & { json?: HostRunSubmitResult }>(fetchImpl, baseUrl, "/runs", input);
  yield { event: "submitted", data: submitted };
  const id = submitted.json?.request.id;
  if (!submitted.ok || !id) return;
  const terminalStatuses = new Set<HostRunRequestStatus>(options.terminalStatuses ?? ["completed", "failed", "cancelled"]);
  for await (const state of streamHostRunState(fetchImpl, baseUrl, id, options)) {
    yield { event: "state", data: state };
    const status = state.request?.status;
    if (status && terminalStatuses.has(status)) return;
  }
}

export async function prepareHostSdkTakeover(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkTakeoverOptions,
  runOptions: HostSdkRunOptions = {}
): Promise<HostSdkPreparedTakeover> {
  const merged = { ...runOptions, ...options };
  const normalizedRunOptions = createHostSdkTakeoverRunOptions({
    ...merged,
    projectDir: options.projectPath ?? merged.projectDir
  });
  const goal = options.goalOverride ?? `Take over ${options.projectPath ?? options.projectDir ?? options.repoSourceDir ?? "project"}`;
  const input = hostRunSpecFromSdk(goal, normalizedRunOptions, {}, "takeover");
  const preflight = await postJson<HostCommandResult & { json?: JsonSafeHostLaunchPlan }>(fetchImpl, baseUrl, "/runs/preflight", input);
  return {
    options,
    runOptions: normalizedRunOptions,
    input,
    preflight
  };
}

export async function* streamHostStatus(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkStatusStreamOptions = {}
): AsyncGenerator<HostStatusSnapshot> {
  const path = pathWithQuery("/status/stream", { interval: options.intervalMs });
  const response = await fetchImpl(urlFor(baseUrl, path), {
    headers: {
      Accept: "text/event-stream"
    },
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`host status stream failed with HTTP ${response.status}`);
  }

  for await (const parsed of streamSseFrames(response.body as HostSdkReadableBody)) {
    if (parsed.event === "status" && parsed.data) yield parsed.data as HostStatusSnapshot;
    if (parsed.event === "error" && parsed.data && typeof parsed.data === "object") {
      const message = (parsed.data as { error?: unknown }).error;
      throw new Error(typeof message === "string" ? message : "host status stream error");
    }
  }
}

export async function* streamHostTimeline(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkTimelineStreamOptions = {}
): AsyncGenerator<HostTimelineEvent[]> {
  const path = pathWithQuery("/timeline/stream", { interval: options.intervalMs, limit: options.limit });
  const response = await fetchImpl(urlFor(baseUrl, path), {
    headers: {
      Accept: "text/event-stream"
    },
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`host timeline stream failed with HTTP ${response.status}`);
  }

  for await (const parsed of streamSseFrames(response.body as HostSdkReadableBody)) {
    if (parsed.event === "timeline" && Array.isArray(parsed.data)) yield parsed.data as HostTimelineEvent[];
    if (parsed.event === "error" && parsed.data && typeof parsed.data === "object") {
      const message = (parsed.data as { error?: unknown }).error;
      throw new Error(typeof message === "string" ? message : "host timeline stream error");
    }
  }
}

export async function* streamHostFrames(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkHostStreamOptions = {}
): AsyncGenerator<HostSdkStreamFrame> {
  const path = pathWithQuery("/host/stream", {
    interval: options.intervalMs,
    limit: options.limit,
    timelineLimit: options.timelineLimit,
    runLimit: options.runLimit,
    status: options.status
  });
  const response = await fetchImpl(urlFor(baseUrl, path), {
    headers: {
      Accept: "text/event-stream"
    },
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`host stream failed with HTTP ${response.status}`);
  }

  for await (const parsed of streamSseFrames(response.body as HostSdkReadableBody)) {
    if (parsed.event === "status" && parsed.data && typeof parsed.data === "object") {
      yield { event: "status", data: parsed.data as HostStatusSnapshot };
    }
    if (parsed.event === "timeline" && Array.isArray(parsed.data)) {
      yield { event: "timeline", data: parsed.data as HostTimelineEvent[] };
    }
    if (parsed.event === "runs" && parsed.data && typeof parsed.data === "object") {
      const requests = (parsed.data as { requests?: unknown }).requests;
      if (Array.isArray(requests)) yield { event: "runs", data: requests as HostRunRequest[] };
    }
    if (parsed.event === "error" && parsed.data && typeof parsed.data === "object") {
      const message = (parsed.data as { error?: unknown }).error;
      throw new Error(typeof message === "string" ? message : "host stream error");
    }
  }
}

export async function* watchHost(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkWatchOptions = {}
): AsyncGenerator<HostSdkWatchFrame> {
  if (options.includeInitialSnapshot !== false) {
    const limit = options.limit ?? Math.max(options.timelineLimit ?? 0, options.runLimit ?? 0, 20);
    yield {
      event: "snapshot",
      data: await getJson<HostSnapshotResponse>(fetchImpl, baseUrl, pathWithQuery("/host/snapshot", { limit, status: options.status }))
    };
  }
  yield* streamHostFrames(fetchImpl, baseUrl, options);
}

export async function* streamHostRunRequests(
  fetchImpl: typeof fetch,
  baseUrl: string,
  options: HostSdkRunRequestsStreamOptions = {}
): AsyncGenerator<HostRunRequest[]> {
  const path = pathWithQuery("/runs/stream", { interval: options.intervalMs, limit: options.limit, status: options.status });
  const response = await fetchImpl(urlFor(baseUrl, path), {
    headers: {
      Accept: "text/event-stream"
    },
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`host run requests stream failed with HTTP ${response.status}`);
  }

  for await (const parsed of streamSseFrames(response.body as HostSdkReadableBody)) {
    if (parsed.event === "runs" && parsed.data && typeof parsed.data === "object") {
      const requests = (parsed.data as { requests?: unknown }).requests;
      if (Array.isArray(requests)) yield requests as HostRunRequest[];
    }
    if (parsed.event === "error" && parsed.data && typeof parsed.data === "object") {
      const message = (parsed.data as { error?: unknown }).error;
      throw new Error(typeof message === "string" ? message : "host run requests stream error");
    }
  }
}

export async function* streamHostRunRequest(
  fetchImpl: typeof fetch,
  baseUrl: string,
  id: string,
  options: HostSdkRunRequestStreamOptions = {}
): AsyncGenerator<HostRunRequest | null> {
  for await (const frame of streamHostRunState(fetchImpl, baseUrl, id, options)) {
    yield frame.request;
  }
}

export async function* streamHostRunState(
  fetchImpl: typeof fetch,
  baseUrl: string,
  id: string,
  options: HostSdkRunRequestStreamOptions = {}
): AsyncGenerator<HostSdkRunStateFrame> {
  const path = pathWithQuery(`/runs/${encodeURIComponent(id)}/stream`, { interval: options.intervalMs });
  const response = await fetchImpl(urlFor(baseUrl, path), {
    headers: {
      Accept: "text/event-stream"
    },
    signal: options.signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`host run request stream failed with HTTP ${response.status}`);
  }

  for await (const parsed of streamSseFrames(response.body as HostSdkReadableBody)) {
    if (parsed.event === "run" && parsed.data && typeof parsed.data === "object") {
      yield parseHostRunStateFrame(parsed.data);
    }
    if (parsed.event === "error" && parsed.data && typeof parsed.data === "object") {
      const message = (parsed.data as { error?: unknown }).error;
      throw new Error(typeof message === "string" ? message : "host run request stream error");
    }
  }
}

function parseHostRunStateFrame(data: unknown): HostSdkRunStateFrame {
  const value = data && typeof data === "object" ? data as { request?: unknown; heartbeat?: unknown; meta?: unknown } : {};
  return {
    request: value.request && typeof value.request === "object" ? value.request as HostRunRequest : null,
    heartbeat: value.heartbeat && typeof value.heartbeat === "object" ? value.heartbeat as HostRunHeartbeatReadResult["heartbeat"] : null,
    meta: value.meta && typeof value.meta === "object" ? value.meta as HostRunMetaReadResult["meta"] : null
  };
}

export async function runHostSdkCommand<TJson = unknown>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  request: HostCommandRequest
): Promise<HostCommandResult & { json?: TJson }> {
  const response = await fetchImpl(urlFor(baseUrl, "/commands/run"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });
  const result = await readJson<HostCommandResult & { json?: TJson }>(response);
  if (!response.ok && !result.error) {
    result.error = `host command failed with HTTP ${response.status}`;
  }
  return result;
}

async function getJson<T>(fetchImpl: typeof fetch, baseUrl: string, path: string): Promise<T> {
  const response = await fetchImpl(urlFor(baseUrl, path));
  return readJson<T>(response);
}

async function postJson<T>(fetchImpl: typeof fetch, baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetchImpl(urlFor(baseUrl, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readJson<T>(response);
}

async function patchJson<T>(fetchImpl: typeof fetch, baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetchImpl(urlFor(baseUrl, path), {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readJson<T>(response);
}

async function deleteJson<T>(fetchImpl: typeof fetch, baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetchImpl(urlFor(baseUrl, path), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return readJson<T>(response);
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`host SDK expected JSON response from ${response.url || "host server"}`);
  }
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("host SDK baseUrl must be http or https");
  return url.toString().replace(/\/+$/, "");
}

function cleanSdkString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function globalLocationLike(): HostSdkLocationLike | undefined {
  const location = (globalThis as { location?: Partial<HostSdkLocationLike> }).location;
  if (!location || typeof location.protocol !== "string" || typeof location.hostname !== "string") return undefined;
  return {
    protocol: location.protocol,
    hostname: location.hostname,
    port: typeof location.port === "string" ? location.port : undefined,
    origin: typeof location.origin === "string" ? location.origin : undefined
  };
}

function isLocalHostName(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "[::1]";
}

function urlFor(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function pathWithQuery(path: string, query: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function parseSseFrame(frame: string): { event: string; data?: unknown } {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (data.length === 0) return { event };
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: data.join("\n") };
  }
}

function isAsyncIterableBody(body: HostSdkReadableBody): body is AsyncIterable<Uint8Array> {
  return typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function";
}

async function* readBodyChunks(body: HostSdkReadableBody): AsyncGenerator<Uint8Array> {
  if (isAsyncIterableBody(body)) {
    yield* body;
    return;
  }

  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      if (chunk.value) yield chunk.value;
    }
  } finally {
    reader.releaseLock?.();
  }
}

async function* streamSseFrames(body: HostSdkReadableBody): AsyncGenerator<{ event: string; data?: unknown }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of readBodyChunks(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer, "utf8") > DEFAULT_SSE_MAX_BUFFER_BYTES) {
      throw new Error(`SSE frame exceeded ${DEFAULT_SSE_MAX_BUFFER_BYTES} bytes without a terminator`);
    }
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      yield parseSseFrame(frame);
      index = buffer.indexOf("\n\n");
    }
  }
}

function hostRunSpecFromSdk(
  goal: string,
  options: HostSdkRunOptions,
  spec: Partial<HostRunSpecInput>,
  mode: "run" | "takeover"
): HostRunSpecInput {
  const loopMode = options.infinite ? "infinite" : spec.options?.loopMode;
  return {
    ...spec,
    goal,
    mode,
    projectDir: spec.projectDir ?? options.projectDir,
    repoSourceDir: spec.repoSourceDir ?? options.repoSourceDir,
    repoCloneUrl: spec.repoCloneUrl ?? options.repoCloneUrl,
    workspaceRoot: spec.workspaceRoot ?? options.workspaceRoot,
    gitRoot: spec.gitRoot ?? options.gitRoot,
    options: {
      ...spec.options,
      engine: options.engine ?? spec.options?.engine,
      model: options.model ?? spec.options?.model,
      fastModel: options.fastModel ?? spec.options?.fastModel,
      codexReasoningEffort: options.codexReasoningEffort ?? spec.options?.codexReasoningEffort,
      configPath: options.configPath ?? spec.options?.configPath,
      workerUrl: options.workerUrl ?? spec.options?.workerUrl,
      workerModel: options.workerModel ?? spec.options?.workerModel,
      workerKey: options.workerKey ?? spec.options?.workerKey,
      noBrain: options.noBrain ?? spec.options?.noBrain,
      loops: options.infinite ? undefined : options.loops ?? spec.options?.loops,
      loopMode,
      pollIntervalSeconds: options.pollIntervalSeconds ?? spec.options?.pollIntervalSeconds,
      outputDir: options.outputDir ?? spec.options?.outputDir,
      keepArtifacts: options.keepArtifacts ?? spec.options?.keepArtifacts,
      errorLimit: options.errorLimit ?? spec.options?.errorLimit
    }
  };
}

function hostRunSubmitInputFromSdk(
  goal: string,
  options: HostSdkRunOptions,
  spec: Partial<HostRunSubmitInput>,
  mode: "run" | "takeover"
): HostRunSubmitInput {
  const { requestId, executor, ...planSpec } = spec;
  return {
    ...hostRunSpecFromSdk(goal, options, planSpec, mode),
    requestId,
    executor
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
