import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

let testDir = "";
let configPath = "";
let alertLogPath = "";
const originalConfigDir = process.env.KING_AI_CONFIG_DIR;
const originalTradeConfig = process.env.KING_AI_TRADE_CONFIG;
const originalAlertLog = process.env.KING_AI_ALERT_LOG;

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "king-ai-snr-"));
  configPath = join(testDir, "trade_config.json");
  alertLogPath = join(testDir, "alert_log.jsonl");
  process.env.KING_AI_CONFIG_DIR = testDir;
  process.env.KING_AI_TRADE_CONFIG = configPath;
  process.env.KING_AI_ALERT_LOG = alertLogPath;
  await writeFile(
    configPath,
    JSON.stringify({
      alerts: { confluence: { enabled: true, window_seconds: 900 } },
      stocks: { watchlist: { RKLB: "Rocket Lab" } },
      treasury: {
        price_watchlist: { TLT: "20+ year Treasury ETF" },
        yield_watchlist: { "^TNX": "10 year yield" },
      },
    }),
    "utf8",
  );
});

after(async () => {
  if (originalConfigDir == null) delete process.env.KING_AI_CONFIG_DIR;
  else process.env.KING_AI_CONFIG_DIR = originalConfigDir;
  if (originalTradeConfig == null) delete process.env.KING_AI_TRADE_CONFIG;
  else process.env.KING_AI_TRADE_CONFIG = originalTradeConfig;
  if (originalAlertLog == null) delete process.env.KING_AI_ALERT_LOG;
  else process.env.KING_AI_ALERT_LOG = originalAlertLog;
  await rm(testDir, { recursive: true, force: true });
});

async function loadTradeModules() {
  const [alertRule, scheduler, treasury, stocks, celebrity, store, domain] = await Promise.all([
    import("../src/trade/alert-rule.js"),
    import("../src/trade/rule-scheduler.js"),
    import("../src/trade/rules/rule-b-treasury.js"),
    import("../src/trade/rules/rule-f-stocks.js"),
    import("../src/trade/rules/rule-t-celebrity.js"),
    import("../src/trade/store.js"),
    import("../src/trade/domain.js"),
  ]);
  return { alertRule, scheduler, treasury, stocks, celebrity, store, domain };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function yahooQuoteResponse(price: number, previousClose: number): Response {
  return jsonResponse({
    chart: {
      result: [{ meta: { regularMarketPrice: price, chartPreviousClose: previousClose } }],
    },
  });
}

describe("trade alert SNR regressions", () => {
  it("suppresses drifted Treasury yields at the same severity", async () => {
    const { alertRule, treasury } = await loadTradeModules();
    const originalFetch = globalThis.fetch;
    const yields = [
      { current: 4.523, previous: 4.47 },
      { current: 4.529, previous: 4.476 },
    ];
    let yieldIndex = 0;
    globalThis.fetch = (async (input) => {
      const url = decodeURIComponent(String(input));
      if (url.includes("TLT")) return yahooQuoteResponse(0, 0);
      if (url.includes("range=5y")) {
        return jsonResponse({
          chart: {
            result: [{ meta: { regularMarketPrice: 4.529 }, indicators: { quote: [{ close: [5.1] }] } }],
          },
        });
      }
      const quote = yields[yieldIndex++]!;
      return yahooQuoteResponse(quote.current, quote.previous);
    }) as typeof fetch;

    try {
      const rule = treasury.createRuleB();
      const state = new alertRule.AlertState({});
      const first = await rule.check(state);
      const second = await rule.check(state);
      assert.equal(first.length + second.length, 1);
      assert.equal(first[0]?.severity, "warning");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("persists cooldowns immediately after one scheduled rule tick", async () => {
    const { alertRule, scheduler, store } = await loadTradeModules();
    const tradeStore = store.getTradeStore();
    const cooldowns: Record<string, number> = {};
    const state = new alertRule.AlertState({}, cooldowns);
    const rule = {
      name: "scheduler persistence",
      ruleKey: "panews",
      defaultCooldown: 60,
      check(currentState: InstanceType<typeof alertRule.AlertState>) {
        currentState.canAlert("scheduler_single_tick", 60);
        return [];
      },
    };

    await scheduler.runScheduledRuleTick(rule, state, { dryRun: true }, (claimed, memo) =>
      tradeStore.saveCooldowns(claimed, memo),
    );

    const persisted = await tradeStore.loadCooldowns();
    assert.ok(persisted.scheduler_single_tick);
  });

  it("writes confluence promotion into the audit JSONL", async () => {
    const { alertRule, store } = await loadTradeModules();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => jsonResponse({ data: [{ last: "100" }] })) as typeof fetch;
    const tradeStore = store.getTradeStore();
    await tradeStore.recordSignal("treasury", "RKLB", "突破", "warning");
    const alert = alertRule.createAlert({
      ruleId: "stocks",
      severity: "info",
      title: "RKLB move",
      detail: "price move",
      asset: "RKLB",
      direction: 1,
    });

    try {
      await alertRule.runRuleTick(
        {
          name: "stock move",
          ruleKey: "stocks",
          defaultCooldown: 60,
          check: () => [alert],
        },
        new alertRule.AlertState({}),
        { confluenceEnabled: true, confluenceWindowSeconds: 900 },
      );
      const rows = (await readFile(alertLogPath, "utf8")).trim().split("\n");
      const audited = JSON.parse(rows.at(-1)!) as Record<string, unknown>;
      assert.equal(audited.severity, "warning");
      assert.equal(audited.confluence_promoted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps celebrity confidence and alpha type onto alert signal fields", async () => {
    const { celebrity } = await loadTradeModules();
    const base = {
      severity: "warning" as const,
      title: "alpha",
      detail: "detail",
      asset: "RKLB",
      tokenContract: "",
      tokenChain: "",
      tags: ["celebrity"],
    };
    const endorsement = celebrity.createCelebrityAlert({
      ...base,
      alphaType: "endorsement",
      confidence: 0.83,
    });
    const policy = celebrity.createCelebrityAlert({ ...base, alphaType: "policy", confidence: 0.91 });

    assert.equal(endorsement.strength, 0.83);
    assert.equal(endorsement.direction, 1);
    assert.equal(policy.strength, 0.91);
    assert.equal(policy.direction, 0);
  });

  it("counts critical pushes while warnings continue to respect the daily cap", async () => {
    const { alertRule, store, domain } = await loadTradeModules();
    const tradeStore = store.getTradeStore();
    const critical = alertRule.createAlert({
      ruleId: "treasury",
      severity: "critical",
      title: "critical",
      detail: "detail",
    });
    const warning = alertRule.createAlert({
      ruleId: "treasury",
      severity: "warning",
      title: "warning",
      detail: "detail",
    });

    assert.equal((await alertRule.filterTgWorthy([critical])).length, 1);
    assert.equal(await tradeStore.getDailyPushCount("treasury"), 1);

    const cap = domain.dailyPushCapFor("treasury");
    while ((await tradeStore.getDailyPushCount("treasury")) < cap) {
      await tradeStore.bumpDailyPush("treasury");
    }
    assert.equal((await alertRule.filterTgWorthy([warning])).length, 0);
    assert.equal((await alertRule.filterTgWorthy([critical])).length, 1);
    assert.equal(await tradeStore.getDailyPushCount("treasury"), cap + 1);
  });

  it("only re-alerts regular stock moves on a higher two-point band", async () => {
    const { alertRule, stocks } = await loadTradeModules();
    const originalFetch = globalThis.fetch;
    const prices = [92, 91.9, 89.7, 89.6];
    let priceIndex = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("range=2d")) {
        return jsonResponse({ chart: { result: [{ meta: { regularMarketPrice: prices[priceIndex - 1] } }] } });
      }
      return yahooQuoteResponse(prices[priceIndex++]!, 100);
    }) as typeof fetch;

    try {
      const rule = stocks.createRuleF();
      const state = new alertRule.AlertState({});
      const counts: number[] = [];
      for (let i = 0; i < prices.length; i++) counts.push((await rule.check(state)).length);
      assert.deepEqual(counts, [1, 0, 1, 0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses the same higher-band escalation for extended stock moves", async () => {
    const { alertRule, stocks } = await loadTradeModules();
    const originalFetch = globalThis.fetch;
    const extendedPrices = [92, 91.9, 89.7, 89.6];
    let extendedIndex = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (!url.includes("range=2d")) return yahooQuoteResponse(100, 100);
      const extendedPrice = extendedPrices[extendedIndex++]!;
      return jsonResponse({
        chart: {
          result: [
            {
              meta: { regularMarketPrice: 100, regularMarketTime: 100 },
              timestamp: [200],
              indicators: { quote: [{ close: [extendedPrice] }] },
            },
          ],
        },
      });
    }) as typeof fetch;

    try {
      const rule = stocks.createRuleF();
      const state = new alertRule.AlertState({});
      const counts: number[] = [];
      for (let i = 0; i < extendedPrices.length; i++) counts.push((await rule.check(state)).length);
      assert.deepEqual(counts, [1, 0, 1, 0]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
