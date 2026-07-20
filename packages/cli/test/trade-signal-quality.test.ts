import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  aggregateQualityMetrics,
  directionalEdge,
  directionalHit,
  forwardReturnPct,
  isEligibleAuditRow,
  outcomeCacheKey,
  parseAuditJsonlLine,
  priceAtTimestamp,
  runSignalQuality,
  type OkxCandle,
  type SignalOutcomeRow,
} from "../src/trade/signal-quality.js";

const HOUR_MS = 3_600_000;

function candle(openMs: number, close: number): OkxCandle {
  return [String(openMs), String(close), String(close), String(close), String(close), "0", "0"];
}

describe("priceAtTimestamp candle matching", () => {
  const base = Date.parse("2026-06-01T12:00:00.000Z");
  const candles: OkxCandle[] = [
    candle(base + 3 * HOUR_MS, 130),
    candle(base + 2 * HOUR_MS, 120),
    candle(base + HOUR_MS, 110),
    candle(base, 100),
    candle(base - HOUR_MS, 90),
  ];

  it("uses the close of the candle whose hour contains T", () => {
    assert.equal(priceAtTimestamp(candles, base + 30 * 60_000), 100);
    assert.equal(priceAtTimestamp(candles, base + HOUR_MS + 1), 110);
  });

  it("falls back to nearest candle within 2h", () => {
    // No candle hour contains T; nearest open within 2h is used.
    const sparse: OkxCandle[] = [candle(base, 100), candle(base + 5 * HOUR_MS, 150)];
    const near = base + 90 * 60_000; // 1.5h after base open → fallback to base close
    assert.equal(priceAtTimestamp(sparse, near), 100);
    // 1.5h before a lone candle open also falls back
    assert.equal(priceAtTimestamp([candle(base + 2 * HOUR_MS, 120)], base + 30 * 60_000), 120);
  });

  it("returns null when out of range beyond 2h", () => {
    const sparse: OkxCandle[] = [candle(base, 100)];
    assert.equal(priceAtTimestamp(sparse, base + 5 * HOUR_MS), null);
  });
});

describe("hit rate and edge math", () => {
  it("treats long hits when ret>0 and short hits when ret<0", () => {
    assert.equal(directionalHit(1, 2.5), true);
    assert.equal(directionalHit(1, -1), false);
    assert.equal(directionalHit(-1, -3), true);
    assert.equal(directionalHit(-1, 1), false);
  });

  it("excludes direction==0 from hit rate and edge", () => {
    assert.equal(directionalHit(0, 5), null);
    assert.equal(directionalEdge(0, 5), null);
  });

  it("edge is sign(direction)*ret", () => {
    assert.equal(directionalEdge(1, 4), 4);
    assert.equal(directionalEdge(-1, -3), 3);
    assert.equal(directionalEdge(-1, 2), -2);
  });

  it("forwardReturnPct is percent change", () => {
    assert.equal(forwardReturnPct(100, 110), 10);
    assert.equal(forwardReturnPct(100, 90), -10);
  });

  it("aggregateQualityMetrics skips direction==0 for hit/edge and reports unpriced", () => {
    const rows: SignalOutcomeRow[] = [
      {
        key: "a",
        rule_id: "panews",
        asset: "BTC",
        severity: "warning",
        direction: 1,
        alert_ts: "t",
        ret_4h: 2,
        ret_24h: -1,
        status: "priced",
      },
      {
        key: "b",
        rule_id: "panews",
        asset: "ETH",
        severity: "info",
        direction: 0,
        alert_ts: "t",
        ret_4h: 5,
        ret_24h: 5,
        status: "priced",
      },
      {
        key: "c",
        rule_id: "meme_large",
        asset: "PEPE",
        severity: "critical",
        direction: -1,
        alert_ts: "t",
        ret_4h: null,
        ret_24h: null,
        status: "unpriced",
      },
    ];
    const metrics = aggregateQualityMetrics(rows);
    const panews = metrics.find((m) => m.rule_id === "panews")!;
    assert.equal(panews.alerts, 2);
    assert.equal(panews.pushed, 1);
    assert.equal(panews.hit_rate_4h, 100); // only directional row counts
    const total = metrics.find((m) => m.rule_id === "TOTAL")!;
    assert.equal(total.alerts, 3);
    assert.ok(total.priced_pct < 100);
  });
});

describe("audit JSONL parsing", () => {
  it("tolerates malformed lines and missing required fields", () => {
    assert.equal(parseAuditJsonlLine("not-json"), null);
    assert.equal(parseAuditJsonlLine(""), null);
    assert.equal(parseAuditJsonlLine("{}"), null);
    const ok = parseAuditJsonlLine(
      JSON.stringify({
        rule_id: "stocks",
        severity: "warning",
        title: "x",
        timestamp: "2026-06-01T00:00:00.000Z",
        direction: 1,
        asset: "RKLB",
      }),
    );
    assert.ok(ok);
    assert.equal(ok!.asset, "RKLB");
  });

  it("requires non-empty asset and age window for eligibility", () => {
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    const aged = {
      rule_id: "stocks",
      severity: "warning",
      title: "x",
      timestamp: new Date(now - 48 * HOUR_MS).toISOString(),
      direction: 1,
      asset: "BTC",
    };
    assert.equal(isEligibleAuditRow(aged, now, 30), true);
    assert.equal(isEligibleAuditRow({ ...aged, asset: "" }, now, 30), false);
    assert.equal(isEligibleAuditRow({ ...aged, timestamp: new Date(now - 2 * HOUR_MS).toISOString() }, now, 30), false);
  });
});

describe("outcome cache key and skip-already-computed", () => {
  it("is stable sha1 of timestamp|rule_id|asset|title", () => {
    const a = outcomeCacheKey("2026-06-01T00:00:00.000Z", "panews", "BTC", "title");
    const b = outcomeCacheKey("2026-06-01T00:00:00.000Z", "panews", "BTC", "title");
    assert.equal(a, b);
    assert.equal(a.length, 40);
    assert.notEqual(a, outcomeCacheKey("2026-06-01T00:00:00.000Z", "panews", "ETH", "title"));
  });

  it("skips recomputation when cache already has the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-sq-"));
    const alertLog = join(dir, "alerts.jsonl");
    const outcomes = join(dir, "outcomes.jsonl");
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const alertTs = new Date(now - 48 * HOUR_MS).toISOString();
    const hourOpen = Date.parse(alertTs);
    const floor = Math.floor(hourOpen / HOUR_MS) * HOUR_MS;

    await writeFile(
      alertLog,
      `${JSON.stringify({
        rule_id: "panews",
        severity: "warning",
        title: "BTC news",
        timestamp: alertTs,
        direction: 1,
        asset: "BTC",
      })}\n`,
      "utf8",
    );

    let fetchCount = 0;
    const candles: OkxCandle[] = [];
    for (let i = -2; i <= 26; i++) {
      candles.push(candle(floor + i * HOUR_MS, 100 + i));
    }

    const fetcher = async () => {
      fetchCount += 1;
      return candles;
    };

    await runSignalQuality({
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: fetcher,
      writeOut: () => {},
    });
    assert.equal(fetchCount, 1);

    await runSignalQuality({
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: fetcher,
      writeOut: () => {},
    });
    assert.equal(fetchCount, 1, "second run should reuse cache");

    const body = await readFile(outcomes, "utf8");
    assert.equal(body.trim().split("\n").length, 1);

    await rm(dir, { recursive: true, force: true });
  });

  it("marks unknown instruments as unpriced when candles are empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-sq-un-"));
    const alertLog = join(dir, "alerts.jsonl");
    const outcomes = join(dir, "outcomes.jsonl");
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const alertTs = new Date(now - 48 * HOUR_MS).toISOString();
    await writeFile(
      alertLog,
      `${JSON.stringify({
        rule_id: "meme_large",
        severity: "critical",
        title: "unknown token",
        timestamp: alertTs,
        direction: -1,
        asset: "NOTAREAL",
      })}\nbad-json-line\n`,
      "utf8",
    );

    const metrics = await runSignalQuality({
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: async () => [],
      writeOut: () => {},
    });
    const total = metrics.find((m) => m.rule_id === "TOTAL")!;
    assert.equal(total.alerts, 1);
    assert.equal(total.priced_pct, 0);

    const cached = JSON.parse((await readFile(outcomes, "utf8")).trim()) as SignalOutcomeRow;
    assert.equal(cached.status, "unpriced");
    assert.equal(cached.ret_4h, null);

    await rm(dir, { recursive: true, force: true });
  });

  it("fetcher failure skips rows without caching so they retry next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-sq-fail-"));
    const alertLog = join(dir, "alerts.jsonl");
    const outcomes = join(dir, "outcomes.jsonl");
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const alertTs = new Date(now - 48 * HOUR_MS).toISOString();
    const floor = Math.floor(Date.parse(alertTs) / HOUR_MS) * HOUR_MS;
    await writeFile(
      alertLog,
      `${JSON.stringify({
        rule_id: "stocks",
        severity: "warning",
        title: "move",
        timestamp: alertTs,
        direction: 1,
        asset: "BTC",
      })}\n`,
      "utf8",
    );

    const failing = await runSignalQuality({
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: async () => {
        throw new Error("okx candle fetch failed for BTC");
      },
      writeOut: () => {},
    });
    // Row is excluded from metrics and the cache stays empty.
    assert.equal(failing.length, 1);
    assert.equal(failing[0]!.rule_id, "TOTAL");
    assert.equal(failing[0]!.alerts, 0);
    const cacheText = await readFile(outcomes, "utf8").catch(() => "");
    assert.equal(cacheText.trim(), "");

    // Next run with a healthy fetcher prices the same row.
    const candles: OkxCandle[] = [];
    for (let i = -1; i <= 26; i++) candles.push(candle(floor + i * HOUR_MS, 100 + i));
    const healthy = await runSignalQuality({
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: async () => candles,
      writeOut: () => {},
    });
    const total = healthy.find((m) => m.rule_id === "TOTAL")!;
    assert.equal(total.alerts, 1);
    assert.equal(total.priced_pct, 100);

    await rm(dir, { recursive: true, force: true });
  });

  it("refresh recomputes and rewrites the outcomes file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-sq-rf-"));
    const alertLog = join(dir, "alerts.jsonl");
    const outcomes = join(dir, "outcomes.jsonl");
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    const alertTs = new Date(now - 48 * HOUR_MS).toISOString();
    const floor = Math.floor(Date.parse(alertTs) / HOUR_MS) * HOUR_MS;
    await writeFile(
      alertLog,
      `${JSON.stringify({
        rule_id: "stocks",
        severity: "warning",
        title: "move",
        timestamp: alertTs,
        direction: 1,
        asset: "BTC",
      })}\n`,
      "utf8",
    );

    const candles: OkxCandle[] = [];
    for (let i = -1; i <= 26; i++) candles.push(candle(floor + i * HOUR_MS, 100 + i * 0.5));

    let fetches = 0;
    const opts = {
      days: 30,
      nowMs: now,
      alertLogPath: alertLog,
      outcomesPath: outcomes,
      candleFetcher: async () => {
        fetches += 1;
        return candles;
      },
      writeOut: () => {},
    };

    await runSignalQuality(opts);
    await runSignalQuality({ ...opts, refresh: true });
    assert.equal(fetches, 2);

    await rm(dir, { recursive: true, force: true });
  });
});
