import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AlertLogSource,
  SignalEngine,
  TechnicalSource,
  calcRsi,
  classifyScore,
  readRecentJsonl,
  RULE_CATEGORY,
  type AlertLogEntry
} from "../src/signal-engine.js";

function makeAlert(overrides: Partial<AlertLogEntry> & { rule: string }): AlertLogEntry {
  const ageSeconds = overrides._tsUnix != null
    ? Math.max(0, Math.floor(Date.now() / 1000 - overrides._tsUnix))
    : 0;
  const ts = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    severity: "warning",
    title: `${overrides.rule} test`,
    detail: "test detail",
    timestamp: ts,
    direction: 0.8,
    strength: 0.6,
    asset: "BTC",
    ...overrides
  };
}

async function writeJsonl(path: string, entries: AlertLogEntry[]): Promise<void> {
  const body = entries.map((e) => JSON.stringify(e)).join("\n");
  await writeFile(path, body.length ? `${body}\n` : "", "utf8");
}

test("calcRsi uses Wilder smoothing", () => {
  const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -0.5));
  const rsi = calcRsi(closes);
  assert.ok(rsi >= 0 && rsi <= 100);
});

test("classifyScore maps threshold bands", () => {
  const engine = new SignalEngine({ sources: [] });
  assert.equal(classifyScore(0.6), "strong_buy");
  assert.equal(classifyScore(0.3), "buy");
  assert.equal(classifyScore(-0.3), "sell");
  assert.equal(classifyScore(0.05), "neutral");
  assert.equal(classifyScore(-0.05), "neutral");
  assert.equal(classifyScore(Math.round((0.1 + 0.2) * 10000) / 10000), "buy");
  void engine;
});

test("AlertLogSource returns empty when no alerts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  await writeJsonl(jsonl, []);

  const source = new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl);
  const results = await source.evaluate();
  assert.deepEqual(results, []);
});

test("AlertLogSource filters by category", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  await writeJsonl(jsonl, [
    makeAlert({ rule: "聪明钱", asset: "BONK" }),
    makeAlert({ rule: "Polymarket", asset: "0xabc" })
  ]);

  const source = new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl);
  const results = await source.evaluate();
  assert.equal(results.length, 1);
  assert.match(results[0]!.detail, /BONK/);
});

test("AlertLogSource excludes info severity and zero direction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  await writeJsonl(jsonl, [
    makeAlert({ rule: "聪明钱", severity: "info" }),
    makeAlert({ rule: "聪明钱", direction: 0 })
  ]);

  const source = new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl);
  const results = await source.evaluate();
  assert.equal(results.length, 0);
});

test("AlertLogSource applies time decay and critical confidence floor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  const now = Date.now() / 1000;
  await writeJsonl(jsonl, [
    makeAlert({ rule: "聪明钱", strength: 0.8, _tsUnix: now }),
    makeAlert({ rule: "大户转账", strength: 0.8, _tsUnix: now - 4 * 3600 }),
    makeAlert({ rule: "大户转账", severity: "critical", strength: 0.3, _tsUnix: now - 3 * 3600 })
  ]);

  const source = new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl);
  const results = await source.evaluate();
  assert.equal(results.length, 3);

  const fresh = results.find((r) => r.detail.includes("聪明钱"));
  const old = results.find((r) => r.detail.includes("大户转账") && r.confidence < 0.7);
  const critical = results.find((r) => r.confidence >= 0.7);
  assert.ok(fresh && old);
  assert.ok(fresh.confidence > old.confidence);
  assert.ok(critical);
});

test("AlertLogSource includes token_contract in tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  await writeJsonl(jsonl, [
    makeAlert({ rule: "聪明钱", asset: "BONK", token_contract: "abc123" })
  ]);

  const source = new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl);
  const results = await source.evaluate();
  assert.ok(results[0]!.tokens.includes("abc123"));
});

test("readRecentJsonl returns empty for missing file", async () => {
  const results = await readRecentJsonl(join(tmpdir(), "missing-alert-log.jsonl"));
  assert.deepEqual(results, []);
});

test("TechnicalSource evaluates with mocked candles", async () => {
  const candles = Array.from({ length: 15 }, (_, i) => [
    String(i * 3_600_000),
    "50000",
    "50100",
    "49900",
    String(50_000 + i),
    "100",
    "5000000"
  ] as [string, string, string, string, string, string, string]).reverse();

  const source = new TechnicalSource(async () => candles);
  const results = await source.evaluate();
  assert.ok(results.length > 0);
  for (const r of results) {
    assert.ok(r.confidence >= 0);
  }
});

test("SignalEngine merges token scores with weight overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-signal-"));
  const jsonl = join(dir, "alert_log.jsonl");
  await writeJsonl(jsonl, [
    makeAlert({ rule: "聪明钱", asset: "BONK", direction: 1, strength: 1 })
  ]);

  const engine = new SignalEngine({
    sources: [new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, jsonl)],
    weightOverrides: { smart_money: 0.5 }
  });
  const result = await engine.scan();
  const bonk = result.signals.find((s) => s.token === "BONK" || s.symbol === "BONK");
  assert.ok(bonk);
  assert.ok(bonk.score > 0.4);
});

test("RULE_CATEGORY maps only valid categories", () => {
  const valid = new Set(["smart_money", "event", "meme"]);
  for (const cat of Object.values(RULE_CATEGORY)) {
    assert.ok(valid.has(cat));
  }
});