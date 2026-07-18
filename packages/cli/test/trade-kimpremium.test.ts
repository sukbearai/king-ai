import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AlertState } from "../src/trade/alert-rule.js";
import {
  assessKimpremiumSnapshot,
  buildKimpremiumSnapshot,
  KimpremiumStateStore,
  parseKimpremiumConfig,
} from "../src/trade/kimpremium.js";
import { createRuleKimpremium } from "../src/trade/rules/rule-kimpremium.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function dates(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const value = new Date(Date.UTC(2026, 0, index + 1));
    return value.toISOString().slice(0, 10).replaceAll("-", "");
  });
}

function fixtures() {
  const d = dates(40);
  const asof = d.at(-1)!;
  const ramp = (start: number, step: number) => d.map((_, index) => start + index * step);
  const series = {
    d,
    r2: ramp(20, 0.1),
    liqR: ramp(2, 0.02),
    fin: ramp(30, 0.1),
    dep: ramp(100, 0.2),
    util: ramp(50, 0.1),
  };
  series.r2[series.r2.length - 1] = 31.28;
  series.liqR[series.liqR.length - 1] = 3.8;
  series.fin[series.fin.length - 1] = 34.37;
  series.dep[series.dep.length - 1] = 109.9;
  series.util[series.util.length - 1] = 56.4;

  const thermo = ramp(40, 0.1);
  thermo[thermo.length - 1] = 50.16;
  return {
    meta: {
      asof,
      generated: "2026-02-10 08:00",
      kpi: {
        r2: 31.28,
        r2Pct: 21,
        liq5d: 0.062,
        liqPct: 99,
        mg: 223.8,
        mgPct: 98,
        util: 56.4,
        fin: 34.37,
        dep: 109.9,
      },
    },
    series,
    etf: {
      d,
      thermo,
      asof,
      kpi: { thermo: 50.16 },
    },
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

function fixtureFetch(data: ReturnType<typeof fixtures>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/data/meta.json")) return response(data.meta);
    if (url.endsWith("/data/series.json")) return response(data.series);
    if (url.endsWith("/data/etf.json")) return response(data.etf);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("kimpremium snapshot and risk assessment", () => {
  it("normalizes live-shaped inputs and combines level with daily volatility", () => {
    const data = fixtures();
    const now = new Date("2026-02-10T00:30:00Z");
    const snapshot = buildKimpremiumSnapshot(data.meta, data.series, data.etf, "https://www.kimpremium.com", now);
    const assessment = assessKimpremiumSnapshot(snapshot, parseKimpremiumConfig({}), now);

    assert.equal(snapshot.metrics.liqR, 3.8);
    assert.equal(snapshot.metrics.thermo, 50.16);
    assert.equal(snapshot.delta1d.r2, 31.28 - data.series.r2.at(-2)!);
    assert.equal(snapshot.volatilityPercentile.r2, 100);
    assert.equal(assessment.severity, "critical");
    assert.ok(assessment.issues.some((issue) => issue.key === "liqPct" && issue.severity === "critical"));
    assert.ok(assessment.issues.some((issue) => issue.key === "mgPct" && issue.severity === "warning"));
  });
});

describe("kimpremium rule", () => {
  it("emits one factual alert for a new risky snapshot and suppresses the duplicate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-kimpremium-"));
    tempDirs.push(dir);
    const store = new KimpremiumStateStore(join(dir, "latest.json"), join(dir, "history.jsonl"));
    const data = fixtures();
    let now = new Date("2026-02-10T00:30:00Z");
    const rule = createRuleKimpremium({
      config: { kimpremium: { poll_seconds: 300 } },
      fetchFn: fixtureFetch(data),
      now: () => now,
      stateStore: store,
    });
    const state = new AlertState({ kimpremium: 0 });

    const first = await rule.check(state);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.severity, "critical");
    assert.match(first[0]!.detail, /强平分位/);
    assert.doesNotMatch(first[0]!.detail, /行动框架/);

    now = new Date(now.getTime() + 301_000);
    assert.deepEqual(await rule.check(state), []);
    const history = (await readFile(join(dir, "history.jsonl"), "utf8")).trim().split("\n");
    assert.equal(history.length, 1);
  });

  it("escalates consecutive source failures and exposes heartbeat health", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-kimpremium-"));
    tempDirs.push(dir);
    const store = new KimpremiumStateStore(join(dir, "latest.json"), join(dir, "history.jsonl"));
    let now = new Date("2026-02-10T00:30:00Z");
    const failingFetch = (async () => {
      throw new Error("source unavailable");
    }) as typeof fetch;
    const rule = createRuleKimpremium({
      config: { kimpremium: { poll_seconds: 300 } },
      fetchFn: failingFetch,
      now: () => now,
      stateStore: store,
    });
    const state = new AlertState({ kimpremium: 0 });

    assert.deepEqual(await rule.check(state), []);
    assert.equal(rule.heartbeatStatus?.(), "degraded");
    now = new Date(now.getTime() + 301_000);
    assert.equal((await rule.check(state))[0]!.severity, "warning");
    assert.equal(rule.heartbeatStatus?.(), "error");
    now = new Date(now.getTime() + 301_000);
    assert.equal((await rule.check(state))[0]!.severity, "critical");
    assert.equal((await store.load()).failureStreak, 3);
  });
});
