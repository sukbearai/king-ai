export interface UsageTotals {
  inputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsagePricingRule {
  key: string;
  currency: string;
  inputPerMillionTokens?: number;
  cacheReadInputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  source?: string;
}

export interface UsageCostSummary {
  amount: number;
  currency: string;
  inputCost: number;
  cacheReadInputCost: number;
  outputCost: number;
  pricedTokens: number;
  unpricedTokens: number;
  pricingKeys: string[];
}

export interface AgentRunStats extends UsageTotals {
  turns: number;
  completed: number;
  failed: number;
  lastRunAt?: string;
  lastDurationMs?: number;
  lastStatus?: "completed" | "failed";
  lastModel?: string | null;
}

export interface TokenBudgetCheck {
  budget: number;
  used: number;
  remaining: number;
  warning: boolean;
  exceeded: boolean;
  state: "ok" | "warning" | "exceeded";
}

export interface UsageAgentInput {
  id: string;
  name?: string;
  engine: string;
  model?: string | null;
  runStats?: AgentRunStats;
  tokenBudget?: TokenBudgetCheck;
}

export interface UsageGroupSummary extends UsageTotals {
  key: string;
  turns: number;
  completed: number;
  failed: number;
  agents: number;
  cost?: UsageCostSummary;
}

export interface UsageAgentSummary extends UsageGroupSummary {
  id: string;
  name?: string;
  engine: string;
  model?: string | null;
  lastRunAt?: string;
  lastStatus?: "completed" | "failed";
  tokenBudget?: TokenBudgetCheck;
  cost?: UsageCostSummary;
}

export interface UsageSummary extends UsageTotals {
  agents: UsageAgentSummary[];
  byEngine: UsageGroupSummary[];
  byModel: UsageGroupSummary[];
  turns: number;
  completed: number;
  failed: number;
  budget?: TokenBudgetCheck;
  cost?: UsageCostSummary;
}

export interface UsageExpenseRow extends UsageTotals {
  agentId: string;
  agentName?: string;
  engine: string;
  model: string;
  turns: number;
  completed: number;
  failed: number;
  currency: string;
  amount: number;
  inputCost: number;
  cacheReadInputCost: number;
  outputCost: number;
  pricedTokens: number;
  unpricedTokens: number;
  pricingKeys: string[];
  lastRunAt?: string;
  lastStatus?: "completed" | "failed";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function envNum(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return num(parsed);
}

export function normalizeEngineUsage(usage: unknown): UsageTotals {
  if (!usage || typeof usage !== "object") {
    return { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const rec = usage as Record<string, unknown>;
  const inputTokens = num(rec.input_tokens ?? rec.inputTokens);
  const cacheReadInputTokens = num(rec.cache_read_input_tokens ?? rec.cacheReadInputTokens ?? rec.cachedInputTokens);
  const outputTokens = num(rec.output_tokens ?? rec.outputTokens);
  const totalTokens = num(rec.total_tokens ?? rec.totalTokens) || inputTokens + cacheReadInputTokens + outputTokens;
  return { inputTokens, cacheReadInputTokens, outputTokens, totalTokens };
}

export function emptyAgentRunStats(): AgentRunStats {
  return {
    turns: 0,
    completed: 0,
    failed: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
}

export function recordAgentRunStats(
  current: AgentRunStats,
  args: { status: "completed" | "failed"; usage?: unknown; durationMs: number; model?: string | null; at?: string }
): AgentRunStats {
  const usage = normalizeEngineUsage(args.usage);
  return {
    turns: current.turns + 1,
    completed: current.completed + (args.status === "completed" ? 1 : 0),
    failed: current.failed + (args.status === "failed" ? 1 : 0),
    inputTokens: current.inputTokens + usage.inputTokens,
    cacheReadInputTokens: current.cacheReadInputTokens + usage.cacheReadInputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
    lastRunAt: args.at ?? new Date().toISOString(),
    lastDurationMs: Math.max(0, Math.floor(args.durationMs)),
    lastStatus: args.status,
    lastModel: args.model ?? null
  };
}

export function formatAgentRunStats(stats?: AgentRunStats): string {
  if (!stats || stats.turns === 0) return "";
  const tokens = stats.totalTokens
    ? `${stats.totalTokens} tokens (in=${stats.inputTokens}, cache=${stats.cacheReadInputTokens}, out=${stats.outputTokens})`
    : "tokens unavailable";
  const last = stats.lastRunAt
    ? ` last=${stats.lastStatus ?? "unknown"} ${stats.lastDurationMs ?? 0}ms @ ${stats.lastRunAt}${stats.lastModel ? ` model=${stats.lastModel}` : ""}`
    : "";
  return `runs=${stats.turns} completed=${stats.completed} failed=${stats.failed} ${tokens}${last}`;
}

export function tokenBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const budget = envNum(env.KING_TOKEN_BUDGET);
  return budget > 0 ? budget : null;
}

export function usagePricingFromEnv(env: NodeJS.ProcessEnv = process.env): UsagePricingRule[] {
  const raw = env.KING_USAGE_PRICING;
  if (!raw) return [];
  try {
    return normalizeUsagePricing(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function normalizeUsagePricing(value: unknown): UsagePricingRule[] {
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeUsagePricingRule(entry));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => normalizeUsagePricingRule({
    ...(entry && typeof entry === "object" ? entry as Record<string, unknown> : {}),
    key
  }));
}

export function estimateUsageCost(totals: UsageTotals, pricing?: UsagePricingRule | null): UsageCostSummary | undefined {
  if (!pricing) return undefined;
  const inputRate = pricing.inputPerMillionTokens ?? 0;
  const cacheRate = pricing.cacheReadInputPerMillionTokens ?? inputRate;
  const outputRate = pricing.outputPerMillionTokens ?? 0;
  const inputCost = costForTokens(totals.inputTokens, inputRate);
  const cacheReadInputCost = costForTokens(totals.cacheReadInputTokens, cacheRate);
  const outputCost = costForTokens(totals.outputTokens, outputRate);
  const pricedTokens =
    (inputRate > 0 ? totals.inputTokens : 0) +
    (cacheRate > 0 ? totals.cacheReadInputTokens : 0) +
    (outputRate > 0 ? totals.outputTokens : 0);
  return {
    amount: roundCost(inputCost + cacheReadInputCost + outputCost),
    currency: pricing.currency,
    inputCost,
    cacheReadInputCost,
    outputCost,
    pricedTokens,
    unpricedTokens: Math.max(0, totals.totalTokens - pricedTokens),
    pricingKeys: [pricing.key]
  };
}

export function checkTokenBudget(stats: AgentRunStats | undefined, budget: number | null | undefined): TokenBudgetCheck | undefined {
  if (!stats || !budget) return undefined;
  const used = stats.totalTokens;
  const remaining = budget - used;
  const exceeded = remaining < 0;
  const warning = !exceeded && remaining < budget * 0.2;
  return {
    budget,
    used,
    remaining,
    warning,
    exceeded,
    state: exceeded ? "exceeded" : warning ? "warning" : "ok"
  };
}

export function formatTokenBudgetCheck(check?: TokenBudgetCheck): string {
  if (!check) return "";
  return `budget=${check.budget} used=${check.used} remaining=${check.remaining} state=${check.state}`;
}

export function summarizeAgentUsage(
  agents: UsageAgentInput[] = [],
  budget: number | null | undefined = null,
  pricingRules: UsagePricingRule[] = []
): UsageSummary {
  const summary: UsageSummary = {
    agents: [],
    byEngine: [],
    byModel: [],
    turns: 0,
    completed: 0,
    failed: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  const byEngine = new Map<string, UsageGroupSummary>();
  const byModel = new Map<string, UsageGroupSummary>();
  const pricing = pricingRules.map((rule) => ({ ...rule, key: rule.key.toLowerCase() }));

  for (const agent of agents) {
    const stats = agent.runStats ?? emptyAgentRunStats();
    const model = agent.model ?? stats.lastModel ?? null;
    const cost = estimateUsageCost(stats, selectUsagePricingRule(pricing, agent.engine, model));
    const agentSummary: UsageAgentSummary = {
      key: agent.id,
      id: agent.id,
      name: agent.name,
      engine: agent.engine,
      model,
      turns: stats.turns,
      completed: stats.completed,
      failed: stats.failed,
      agents: 1,
      inputTokens: stats.inputTokens,
      cacheReadInputTokens: stats.cacheReadInputTokens,
      outputTokens: stats.outputTokens,
      totalTokens: stats.totalTokens,
      lastRunAt: stats.lastRunAt,
      lastStatus: stats.lastStatus,
      tokenBudget: agent.tokenBudget,
      cost
    };
    summary.agents.push(agentSummary);
    addUsageTotals(summary, stats);
    addUsageCost(summary, cost);
    summary.turns += stats.turns;
    summary.completed += stats.completed;
    summary.failed += stats.failed;
    addGroup(byEngine, agent.engine || "unknown", stats, cost);
    addGroup(byModel, agentSummary.model || "default", stats, cost);
  }

  summary.agents.sort((left, right) => right.totalTokens - left.totalTokens || left.id.localeCompare(right.id));
  summary.byEngine = [...byEngine.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));
  summary.byModel = [...byModel.values()].sort((left, right) => right.totalTokens - left.totalTokens || left.key.localeCompare(right.key));
  summary.budget = checkTokenBudget(summary, budget);
  return summary;
}

export function formatUsageSummary(summary: UsageSummary): string {
  const lines = [
    "usage summary:",
    `  runs=${summary.turns} completed=${summary.completed} failed=${summary.failed}`,
    `  tokens=${summary.totalTokens} input=${summary.inputTokens} cache=${summary.cacheReadInputTokens} output=${summary.outputTokens}`
  ];
  const budget = formatTokenBudgetCheck(summary.budget);
  if (budget) lines.push(`  token budget: ${budget}`);
  if (summary.cost) lines.push(`  estimated cost: ${formatUsageCost(summary.cost)}`);

  if (summary.byEngine.length) {
    lines.push("by engine:");
    for (const group of summary.byEngine) lines.push(`  - ${formatUsageGroup(group)}`);
  }
  if (summary.byModel.length) {
    lines.push("by model:");
    for (const group of summary.byModel) lines.push(`  - ${formatUsageGroup(group)}`);
  }
  if (summary.agents.length) {
    lines.push("by agent:");
    for (const agent of summary.agents) {
      const label = agent.name ? `${agent.id} (${agent.name})` : agent.id;
      const budgetText = formatTokenBudgetCheck(agent.tokenBudget);
      const costText = agent.cost ? ` cost=${formatUsageCost(agent.cost)}` : "";
      lines.push(`  - ${label}: engine=${agent.engine} model=${agent.model || "default"} ${formatUsageGroup(agent)}${agent.lastRunAt ? ` last=${agent.lastStatus ?? "unknown"}@${agent.lastRunAt}` : ""}${budgetText ? ` ${budgetText}` : ""}${costText}`);
    }
  } else {
    lines.push("by agent: none");
  }
  return lines.join("\n");
}

export function listUsageExpenses(summary: UsageSummary): UsageExpenseRow[] {
  return summary.agents
    .filter((agent) => agent.cost || agent.totalTokens > 0 || agent.turns > 0)
    .map((agent) => {
      const cost = agent.cost;
      return {
        agentId: agent.id,
        agentName: agent.name,
        engine: agent.engine,
        model: agent.model || "default",
        turns: agent.turns,
        completed: agent.completed,
        failed: agent.failed,
        inputTokens: agent.inputTokens,
        cacheReadInputTokens: agent.cacheReadInputTokens,
        outputTokens: agent.outputTokens,
        totalTokens: agent.totalTokens,
        currency: cost?.currency ?? "",
        amount: cost?.amount ?? 0,
        inputCost: cost?.inputCost ?? 0,
        cacheReadInputCost: cost?.cacheReadInputCost ?? 0,
        outputCost: cost?.outputCost ?? 0,
        pricedTokens: cost?.pricedTokens ?? 0,
        unpricedTokens: cost?.unpricedTokens ?? agent.totalTokens,
        pricingKeys: cost?.pricingKeys ?? [],
        lastRunAt: agent.lastRunAt,
        lastStatus: agent.lastStatus
      };
    })
    .sort((left, right) => right.amount - left.amount || right.totalTokens - left.totalTokens || left.agentId.localeCompare(right.agentId));
}

export function formatUsageExpenses(rows: UsageExpenseRow[]): string {
  if (rows.length === 0) return "usage expenses: none";
  const lines = ["usage expenses:"];
  for (const row of rows) {
    const label = row.agentName ? `${row.agentId} (${row.agentName})` : row.agentId;
    const cost = row.currency ? `${row.currency} ${row.amount.toFixed(6)}` : "unpriced";
    const unpriced = row.unpricedTokens ? ` unpricedTokens=${row.unpricedTokens}` : "";
    const keys = row.pricingKeys.length ? ` pricing=${row.pricingKeys.join(",")}` : "";
    const last = row.lastRunAt ? ` last=${row.lastStatus ?? "unknown"}@${row.lastRunAt}` : "";
    lines.push(
      `  - ${label}: ${cost} engine=${row.engine} model=${row.model} runs=${row.turns} completed=${row.completed} failed=${row.failed} tokens=${row.totalTokens} input=${row.inputTokens} cache=${row.cacheReadInputTokens} output=${row.outputTokens} inputCost=${row.inputCost.toFixed(6)} cacheCost=${row.cacheReadInputCost.toFixed(6)} outputCost=${row.outputCost.toFixed(6)}${unpriced}${keys}${last}`
    );
  }
  return lines.join("\n");
}

function addGroup(groups: Map<string, UsageGroupSummary>, key: string, stats: AgentRunStats, cost?: UsageCostSummary): void {
  const group = groups.get(key) ?? {
    key,
    agents: 0,
    turns: 0,
    completed: 0,
    failed: 0,
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  };
  group.agents += 1;
  group.turns += stats.turns;
  group.completed += stats.completed;
  group.failed += stats.failed;
  addUsageTotals(group, stats);
  addUsageCost(group, cost);
  groups.set(key, group);
}

function addUsageTotals(target: UsageTotals, source: UsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.cacheReadInputTokens += source.cacheReadInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalTokens += source.totalTokens;
}

function addUsageCost(target: { cost?: UsageCostSummary }, source?: UsageCostSummary): void {
  if (!source) return;
  if (!target.cost) {
    target.cost = { ...source, pricingKeys: [...source.pricingKeys] };
    return;
  }
  if (target.cost.currency !== source.currency) {
    target.cost.unpricedTokens += source.pricedTokens + source.unpricedTokens;
    return;
  }
  target.cost.amount = roundCost(target.cost.amount + source.amount);
  target.cost.inputCost = roundCost(target.cost.inputCost + source.inputCost);
  target.cost.cacheReadInputCost = roundCost(target.cost.cacheReadInputCost + source.cacheReadInputCost);
  target.cost.outputCost = roundCost(target.cost.outputCost + source.outputCost);
  target.cost.pricedTokens += source.pricedTokens;
  target.cost.unpricedTokens += source.unpricedTokens;
  target.cost.pricingKeys = [...new Set([...target.cost.pricingKeys, ...source.pricingKeys])];
}

function normalizeUsagePricingRule(value: unknown): UsagePricingRule[] {
  if (!value || typeof value !== "object") return [];
  const entry = value as Record<string, unknown>;
  const key = typeof entry.key === "string" ? entry.key.trim().toLowerCase() : "";
  if (!key) return [];
  const rule: UsagePricingRule = {
    key,
    currency: typeof entry.currency === "string" && entry.currency.trim() ? entry.currency.trim().toUpperCase() : "USD",
    inputPerMillionTokens: optionalRate(entry.inputPerMillionTokens ?? entry.inputPerMillion ?? entry.input_tokens_per_million),
    cacheReadInputPerMillionTokens: optionalRate(entry.cacheReadInputPerMillionTokens ?? entry.cacheReadInputPerMillion ?? entry.cachedInputPerMillion ?? entry.cache_read_input_tokens_per_million),
    outputPerMillionTokens: optionalRate(entry.outputPerMillionTokens ?? entry.outputPerMillion ?? entry.output_tokens_per_million),
    source: typeof entry.source === "string" ? entry.source : undefined
  };
  return rule.inputPerMillionTokens || rule.cacheReadInputPerMillionTokens || rule.outputPerMillionTokens ? [rule] : [];
}

function selectUsagePricingRule(pricing: UsagePricingRule[], engine: string, model?: string | null): UsagePricingRule | undefined {
  const engineKey = engine.trim().toLowerCase();
  const modelKey = model?.trim().toLowerCase();
  const candidates = [
    modelKey ? `${engineKey}:${modelKey}` : "",
    modelKey ?? "",
    `${engineKey}:*`,
    engineKey,
    "*"
  ].filter(Boolean);
  return candidates.map((key) => pricing.find((rule) => rule.key === key)).find((rule): rule is UsagePricingRule => Boolean(rule));
}

function optionalRate(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function costForTokens(tokens: number, perMillionTokens: number): number {
  return roundCost(tokens / 1_000_000 * perMillionTokens);
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatUsageCost(cost: UsageCostSummary): string {
  const unpriced = cost.unpricedTokens ? ` unpricedTokens=${cost.unpricedTokens}` : "";
  return `${cost.currency} ${cost.amount.toFixed(6)}${unpriced}`;
}

function formatUsageGroup(group: UsageGroupSummary): string {
  return `${group.key}: runs=${group.turns} completed=${group.completed} failed=${group.failed} tokens=${group.totalTokens} input=${group.inputTokens} cache=${group.cacheReadInputTokens} output=${group.outputTokens}`;
}
