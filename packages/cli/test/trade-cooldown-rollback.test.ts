import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Alert, AlertState as AlertStateType } from "../src/trade/alert-rule.js";

// paths.ts binds CONFIG_DIR (and every TRADE_* path) at import time, so the env
// isolation MUST happen before any src module loads. Static src imports would
// hoist above this block and leak reads/writes into the real ~/.king-ai state;
// keep all runtime src imports dynamic and below the env setup.
const testDir = await mkdtemp(join(tmpdir(), "king-ai-cd-rollback-"));
const configPath = join(testDir, "trade_config.json");
const alertLogPath = join(testDir, "alert_log.jsonl");
const originalConfigDir = process.env.KING_AI_CONFIG_DIR;
const originalTradeConfig = process.env.KING_AI_TRADE_CONFIG;
const originalAlertLog = process.env.KING_AI_ALERT_LOG;
const originalFetch = globalThis.fetch;
process.env.KING_AI_CONFIG_DIR = testDir;
process.env.KING_AI_TRADE_CONFIG = configPath;
process.env.KING_AI_ALERT_LOG = alertLogPath;
await writeFile(
  configPath,
  JSON.stringify({
    alerts: { confluence: { enabled: false }, llm_advice: false },
  }),
  "utf8",
);

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// Avoid live OKX price fetch during audit JSONL writes.
globalThis.fetch = (async () => jsonResponse({ data: [{ last: "100" }] })) as typeof fetch;

const { AlertState, createAlert, runRuleTick } = await import("../src/trade/alert-rule.js");
const { dailyPushCapFor } = await import("../src/trade/domain.js");
const { getTradeStore, resetTradeStoreForTests } = await import("../src/trade/store.js");
resetTradeStoreForTests();

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalConfigDir == null) delete process.env.KING_AI_CONFIG_DIR;
  else process.env.KING_AI_CONFIG_DIR = originalConfigDir;
  if (originalTradeConfig == null) delete process.env.KING_AI_TRADE_CONFIG;
  else process.env.KING_AI_TRADE_CONFIG = originalTradeConfig;
  if (originalAlertLog == null) delete process.env.KING_AI_ALERT_LOG;
  else process.env.KING_AI_ALERT_LOG = originalAlertLog;
  await rm(testDir, { recursive: true, force: true });
});

function remainingCooldown(state: AlertStateType, key: string, cooldownSec: number): number {
  const last = state.cooldowns[key] ?? 0;
  const now = Date.now() / 1000;
  return Math.max(0, cooldownSec - (now - last));
}

describe("AlertState cooldown reserve/rollback", () => {
  it("rollbackClaim on an unclaimed key is a no-op", () => {
    const state = new AlertState({});
    state.cooldowns.unrelated = 1_700_000_000;
    state.rollbackClaim("never_claimed");
    assert.equal(state.cooldowns.never_claimed, undefined);
    assert.equal(state.cooldowns.unrelated, 1_700_000_000);
  });

  it("rollbackClaim leaves ~10% residual after a successful claim", () => {
    const state = new AlertState({});
    const key = "ticker_FOO";
    const cd = 86_400;
    state.beginTick();
    assert.equal(state.tryClaimCooldown(key, cd), true);
    const fullRemaining = remainingCooldown(state, key, cd);
    assert.ok(fullRemaining > cd * 0.99);

    state.rollbackClaim(key);
    const residual = remainingCooldown(state, key, cd);
    assert.ok(residual > 0, `expected residual > 0, got ${residual}`);
    assert.ok(residual < cd * 0.2, `expected residual < 20% of full, got ${residual}`);
    assert.ok(residual > cd * 0.05, `expected residual ~10%, got ${residual}`);
  });
});

describe("runRuleTick cooldown rollback", () => {
  it("warning dropped by daily cap soft-releases cooldown to ~10% residual", async () => {
    resetTradeStoreForTests();
    const store = getTradeStore();
    const ruleId = "treasury";
    const cap = dailyPushCapFor(ruleId);
    while ((await store.getDailyPushCount(ruleId)) < cap) {
      await store.bumpDailyPush(ruleId);
    }

    const key = "treasury_price_TLT_warning";
    const cd = 3600;
    const cooldowns: Record<string, number> = {};
    const state = new AlertState({}, cooldowns);
    const alert = createAlert({
      ruleId,
      severity: "warning",
      title: "TLT dump",
      detail: "d",
      asset: "TLT",
      direction: -1,
      cooldownKey: key,
    });

    await runRuleTick(
      {
        name: "treasury_stress",
        ruleKey: ruleId,
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      {
        pushTg: true,
        confluenceEnabled: false,
        sendTelegram: async () => true,
        adviceGenerator: async () => ({ text: "", source: "fallback" as const }),
      },
    );

    const residual = remainingCooldown(state, key, cd);
    assert.ok(residual > 0 && residual < cd, `expected partial residual, got ${residual}`);
    assert.ok(residual < cd * 0.2, `expected ~10% residual, got ${residual}`);
  });

  it("Telegram chunk failure rolls back delivered-batch cooldown keys", async () => {
    resetTradeStoreForTests();
    const key = "meme_large_abc123";
    const cd = 3600;
    const state = new AlertState({});
    const alert = createAlert({
      ruleId: "meme_large",
      severity: "warning",
      title: "big buy",
      detail: "d",
      asset: "PEPE",
      direction: -0.7,
      cooldownKey: key,
    });

    await runRuleTick(
      {
        name: "meme_large_buys",
        ruleKey: "meme_large",
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      {
        pushTg: true,
        confluenceEnabled: false,
        sendTelegram: async () => false,
        adviceGenerator: async () => ({ text: "", source: "fallback" as const }),
      },
    );

    const residual = remainingCooldown(state, key, cd);
    assert.ok(residual > 0 && residual < cd * 0.2, `expected soft residual after TG fail, got ${residual}`);
  });

  it("Telegram alert delivery stops after the first failed chunk", async () => {
    resetTradeStoreForTests();
    const key = "kimpremium_long_failure";
    const cd = 3600;
    const state = new AlertState({});
    const alert = createAlert({
      ruleId: "kimpremium",
      severity: "critical",
      title: "long failure",
      detail: "x".repeat(5000),
      asset: "BTC",
      direction: -1,
      cooldownKey: key,
    });
    let attempts = 0;

    await runRuleTick(
      {
        name: "kimpremium_leverage",
        ruleKey: "kimpremium",
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      {
        pushTg: true,
        confluenceEnabled: false,
        sendTelegram: async () => {
          attempts += 1;
          return false;
        },
        adviceGenerator: async () => ({ text: "", source: "fallback" as const }),
      },
    );

    assert.equal(attempts, 1);
    const residual = remainingCooldown(state, key, cd);
    assert.ok(residual > 0 && residual < cd * 0.2, `expected soft residual after TG fail, got ${residual}`);
  });

  it("info alert is not rolled back when daily cap drops it from TG", async () => {
    resetTradeStoreForTests();
    const store = getTradeStore();
    const ruleId = "stocks";
    const cap = dailyPushCapFor(ruleId);
    while ((await store.getDailyPushCount(ruleId)) < cap) {
      await store.bumpDailyPush(ruleId);
    }

    const key = "stock_RKLB_b2";
    const cd = 72_000;
    const state = new AlertState({});
    const alert = createAlert({
      ruleId,
      severity: "info",
      title: "RKLB move",
      detail: "d",
      asset: "RKLB",
      direction: 1,
      cooldownKey: key,
    });

    const claimTsBefore = Date.now() / 1000;
    await runRuleTick(
      {
        name: "stock_move",
        ruleKey: ruleId,
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      {
        pushTg: true,
        confluenceEnabled: false,
        sendTelegram: async () => true,
        adviceGenerator: async () => ({ text: "", source: "fallback" as const }),
      },
    );

    // Info never enters TG path for cap rollback; full claim should remain.
    const last = state.cooldowns[key] ?? 0;
    assert.ok(last >= claimTsBefore - 1, `info claim should stay full, last=${last}`);
    const remaining = remainingCooldown(state, key, cd);
    assert.ok(remaining > cd * 0.9, `expected near-full cooldown for info, got ${remaining}`);
  });

  it("delivered warning keeps the full cooldown", async () => {
    resetTradeStoreForTests();
    const key = "wba_deadbeef";
    const cd = 86_400;
    const state = new AlertState({});
    const alert = createAlert({
      ruleId: "discord_wba",
      severity: "warning",
      title: "wba signal",
      detail: "d",
      asset: "BTC",
      direction: 0,
      cooldownKey: key,
    });

    let sent = 0;
    await runRuleTick(
      {
        name: "discord_wba",
        ruleKey: "discord_wba",
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      {
        pushTg: true,
        confluenceEnabled: false,
        sendTelegram: async () => {
          sent += 1;
          return true;
        },
        adviceGenerator: async () => ({ text: "", source: "fallback" as const }),
      },
    );

    assert.ok(sent >= 1);
    const remaining = remainingCooldown(state, key, cd);
    assert.ok(remaining > cd * 0.9, `delivered alert should keep full cooldown, remaining=${remaining}`);
  });

  it("no rollback when pushTg is false", async () => {
    resetTradeStoreForTests();
    const key = "ticker_ABC";
    const cd = 86_400;
    const state = new AlertState({});
    const alert: Alert = createAlert({
      ruleId: "ticker_velocity",
      severity: "warning",
      title: "$ABC accel",
      detail: "d",
      asset: "ABC",
      cooldownKey: key,
    });

    await runRuleTick(
      {
        name: "ticker_mention_velocity",
        ruleKey: "ticker_velocity",
        defaultCooldown: cd,
        check(s) {
          s.tryClaimCooldown(key, cd);
          return [alert];
        },
      },
      state,
      { pushTg: false, confluenceEnabled: false },
    );

    const remaining = remainingCooldown(state, key, cd);
    assert.ok(remaining > cd * 0.9);
  });
});
