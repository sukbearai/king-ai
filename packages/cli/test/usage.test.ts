import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTokenBudget,
  emptyAgentRunStats,
  estimateUsageCost,
  formatAgentRunStats,
  formatUsageSummary,
  formatTokenBudgetCheck,
  normalizeUsagePricing,
  normalizeEngineUsage,
  recordAgentRunStats,
  summarizeAgentUsage,
  tokenBudgetFromEnv,
  usagePricingFromEnv
} from "../src/usage.js";

test("normalizeEngineUsage accepts snake_case and camelCase token fields", () => {
  assert.deepEqual(normalizeEngineUsage({
    input_tokens: 10,
    cache_read_input_tokens: 3,
    output_tokens: 7
  }), {
    inputTokens: 10,
    cacheReadInputTokens: 3,
    outputTokens: 7,
    totalTokens: 20
  });

  assert.deepEqual(normalizeEngineUsage({
    inputTokens: 4,
    cachedInputTokens: 2,
    outputTokens: 6,
    totalTokens: 99
  }), {
    inputTokens: 4,
    cacheReadInputTokens: 2,
    outputTokens: 6,
    totalTokens: 99
  });
});

test("recordAgentRunStats aggregates turn counts and usage totals", () => {
  let stats = emptyAgentRunStats();
  stats = recordAgentRunStats(stats, {
    status: "completed",
    usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 8 },
    durationMs: 1234,
    model: "gpt-test",
    at: "2026-06-02T00:00:00.000Z"
  });
  stats = recordAgentRunStats(stats, {
    status: "failed",
    usage: { inputTokens: 5, outputTokens: 1 },
    durationMs: 250,
    model: null,
    at: "2026-06-02T00:01:00.000Z"
  });

  assert.equal(stats.turns, 2);
  assert.equal(stats.completed, 1);
  assert.equal(stats.failed, 1);
  assert.equal(stats.inputTokens, 15);
  assert.equal(stats.cacheReadInputTokens, 2);
  assert.equal(stats.outputTokens, 9);
  assert.equal(stats.totalTokens, 26);
  assert.equal(stats.lastStatus, "failed");
  assert.equal(stats.lastDurationMs, 250);
  assert.match(formatAgentRunStats(stats), /runs=2 completed=1 failed=1 26 tokens/);
});

test("formatAgentRunStats hides empty stats", () => {
  assert.equal(formatAgentRunStats(), "");
  assert.equal(formatAgentRunStats(emptyAgentRunStats()), "");
});

test("checkTokenBudget reports ok, warning, and exceeded states", () => {
  let stats = emptyAgentRunStats();
  stats = recordAgentRunStats(stats, {
    status: "completed",
    usage: { totalTokens: 70 },
    durationMs: 1,
    at: "2026-06-02T00:00:00.000Z"
  });
  assert.deepEqual(checkTokenBudget(stats, 100), {
    budget: 100,
    used: 70,
    remaining: 30,
    warning: false,
    exceeded: false,
    state: "ok"
  });
  stats = recordAgentRunStats(stats, {
    status: "completed",
    usage: { totalTokens: 15 },
    durationMs: 1,
    at: "2026-06-02T00:00:01.000Z"
  });
  assert.equal(checkTokenBudget(stats, 100)?.state, "warning");
  stats = recordAgentRunStats(stats, {
    status: "completed",
    usage: { totalTokens: 20 },
    durationMs: 1,
    at: "2026-06-02T00:00:02.000Z"
  });
  const exceeded = checkTokenBudget(stats, 100);
  assert.equal(exceeded?.state, "exceeded");
  assert.match(formatTokenBudgetCheck(exceeded), /budget=100 used=105 remaining=-5 state=exceeded/);
});

test("tokenBudgetFromEnv reads KING env vars", () => {
  assert.equal(tokenBudgetFromEnv({ KING_TOKEN_BUDGET: "1000" } as NodeJS.ProcessEnv), 1000);
  assert.equal(tokenBudgetFromEnv({ KING_TOKEN_BUDGET: "0" } as NodeJS.ProcessEnv), null);
  assert.equal(tokenBudgetFromEnv({ KING_TOKEN_BUDGET: "bad" } as NodeJS.ProcessEnv), null);
});

test("usagePricingFromEnv reads configurable cost rules", () => {
  const pricing = usagePricingFromEnv({
    KING_USAGE_PRICING: JSON.stringify({
      "codex:gpt-test": {
        inputPerMillionTokens: 2,
        cacheReadInputPerMillionTokens: 0.5,
        outputPerMillionTokens: 10
      }
    })
  } as NodeJS.ProcessEnv);

  assert.deepEqual(pricing, [{
    key: "codex:gpt-test",
    currency: "USD",
    inputPerMillionTokens: 2,
    cacheReadInputPerMillionTokens: 0.5,
    outputPerMillionTokens: 10,
    source: undefined
  }]);
  assert.deepEqual(usagePricingFromEnv({ KING_USAGE_PRICING: "not-json" } as NodeJS.ProcessEnv), []);
});

test("estimateUsageCost prices token categories per million tokens", () => {
  const cost = estimateUsageCost({
    inputTokens: 1_000_000,
    cacheReadInputTokens: 500_000,
    outputTokens: 250_000,
    totalTokens: 1_750_000
  }, {
    key: "codex:gpt-test",
    currency: "USD",
    inputPerMillionTokens: 2,
    cacheReadInputPerMillionTokens: 0.5,
    outputPerMillionTokens: 10
  });

  assert.deepEqual(cost, {
    amount: 4.75,
    currency: "USD",
    inputCost: 2,
    cacheReadInputCost: 0.25,
    outputCost: 2.5,
    pricedTokens: 1_750_000,
    unpricedTokens: 0,
    pricingKeys: ["codex:gpt-test"]
  });
});

test("summarizeAgentUsage groups usage by engine, model, and agent", () => {
  const codexStats = recordAgentRunStats(emptyAgentRunStats(), {
    status: "completed",
    usage: { inputTokens: 10, cacheReadInputTokens: 5, outputTokens: 15 },
    durationMs: 1000,
    model: "gpt-test",
    at: "2026-06-02T00:00:00.000Z"
  });
  const claudeStats = recordAgentRunStats(emptyAgentRunStats(), {
    status: "failed",
    usage: { input_tokens: 7, output_tokens: 3 },
    durationMs: 2000,
    model: "opus-test",
    at: "2026-06-02T00:01:00.000Z"
  });

  const summary = summarizeAgentUsage([
    { id: "dev", name: "Dev", engine: "codex", model: "gpt-test", runStats: codexStats },
    { id: "reviewer", name: "Reviewer", engine: "claude", model: "opus-test", runStats: claudeStats }
  ], 60);

  assert.equal(summary.turns, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.totalTokens, 40);
  assert.equal(summary.budget?.state, "ok");
  assert.deepEqual(summary.byEngine.map((group) => [group.key, group.totalTokens]), [["codex", 30], ["claude", 10]]);
  assert.deepEqual(summary.byModel.map((group) => [group.key, group.totalTokens]), [["gpt-test", 30], ["opus-test", 10]]);
  assert.deepEqual(summary.agents.map((agent) => agent.id), ["dev", "reviewer"]);

  const rendered = formatUsageSummary(summary);
  assert.match(rendered, /usage summary/);
  assert.match(rendered, /runs=2 completed=1 failed=1/);
  assert.match(rendered, /tokens=40 input=17 cache=5 output=18/);
  assert.match(rendered, /by engine:/);
  assert.match(rendered, /codex: runs=1 completed=1 failed=0 tokens=30/);
  assert.match(rendered, /claude: runs=1 completed=0 failed=1 tokens=10/);
  assert.match(rendered, /by model:/);
  assert.match(rendered, /dev \(Dev\): engine=codex model=gpt-test/);
});

test("summarizeAgentUsage includes optional King cost estimates", () => {
  const codexStats = recordAgentRunStats(emptyAgentRunStats(), {
    status: "completed",
    usage: { inputTokens: 1_000_000, cacheReadInputTokens: 500_000, outputTokens: 250_000 },
    durationMs: 1000,
    model: "gpt-test",
    at: "2026-06-02T00:00:00.000Z"
  });
  const claudeStats = recordAgentRunStats(emptyAgentRunStats(), {
    status: "completed",
    usage: { inputTokens: 1000, outputTokens: 2000 },
    durationMs: 1000,
    model: "opus-test",
    at: "2026-06-02T00:01:00.000Z"
  });

  const summary = summarizeAgentUsage([
    { id: "dev", engine: "codex", model: "gpt-test", runStats: codexStats },
    { id: "reviewer", engine: "claude", model: "opus-test", runStats: claudeStats }
  ], null, normalizeUsagePricing({
    "codex:gpt-test": {
      inputPerMillionTokens: 2,
      cacheReadInputPerMillionTokens: 0.5,
      outputPerMillionTokens: 10
    },
    "claude:*": {
      inputPerMillionTokens: 3,
      outputPerMillionTokens: 15
    }
  }));

  assert.equal(summary.cost?.amount, 4.783);
  assert.equal(summary.cost?.currency, "USD");
  assert.deepEqual(summary.cost?.pricingKeys, ["codex:gpt-test", "claude:*"]);
  assert.equal(summary.agents.find((agent) => agent.id === "dev")?.cost?.amount, 4.75);
  assert.equal(summary.byEngine.find((group) => group.key === "claude")?.cost?.amount, 0.033);
  assert.match(formatUsageSummary(summary), /estimated cost: USD 4\.783000/);
});

test("formatUsageSummary renders empty running state", () => {
  assert.match(formatUsageSummary(summarizeAgentUsage()), /by agent: none/);
});
