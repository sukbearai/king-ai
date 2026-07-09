export type EngineId = "claude" | "codex" | "grok";
export type AgentLifecycle = "on-demand" | "24/7" | "idle_cached" | "disabled";

export interface ComputerConfig {
  serverUrl: string;
  computerId: string;
  deviceToken: string;
  tenantId?: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  role?: string;
  engine?: EngineId;
  model?: string;
  fastModel?: string;
  reasoningEffort?: string;
  lifecycle?: AgentLifecycle;
}

export interface RuntimeRun {
  runId?: string;
  contract?: RuntimeRunContract;
}

export interface RuntimeRunContract {
  agentId?: string;
  conversationId?: string;
  requestId?: string;
  messageId?: string;
  taskId?: string;
}

export interface TriageVerdict {
  actionable: boolean;
  reason?: string;
  promptNote?: string;
  source?: string;
  responseMode?: "me" | "each" | "one-of-us";
  routeHint?: "ignore" | "monitor" | "respond" | "steer";
  priority?: "normal" | "steer" | "urgent";
}

export interface EngineUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

export interface EngineResult {
  exitCode: number;
  error?: string;
  sessionId?: string | null;
  usage?: EngineUsage;
  model?: string | null;
}

export interface EngineTurnOptions {
  imagePaths?: string[];
}

export interface EngineSession {
  readonly alive: boolean;
  readonly sessionId: string | null;
  readonly carriesStandingPrompt: boolean;
  send(prompt: string, options?: EngineTurnOptions): Promise<EngineResult>;
  steer(text: string): void;
  stop(): void;
}

export interface EngineRunArgs {
  home: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  fastModel?: string;
  reasoningEffort?: string;
  resumeSessionId?: string | null;
  standingPrompt?: string;
  imagePaths?: string[];
  signal: AbortSignal;
  onLog: (line: string) => void;
}

export interface EngineProbeArgs {
  cwd: string;
  env: NodeJS.ProcessEnv;
  tier: "small" | "big";
  signal: AbortSignal;
}

export interface EngineClassifyArgs {
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  model?: string;
  signal: AbortSignal;
  onLog?: (line: string) => void;
}

export interface EngineAdapter {
  id: EngineId;
  bin: string;
  seedHome(home: string, persona: { id: string; name: string; role?: string }): Promise<void>;
  classify(args: EngineClassifyArgs): Promise<{ text: string; error?: string; usage?: EngineUsage }>;
  probe(args: EngineProbeArgs): Promise<{ text: string; error?: string }>;
  run(args: EngineRunArgs): Promise<EngineResult>;
  startSession?(args: Omit<EngineRunArgs, "prompt" | "signal">): EngineSession | null;
}
