import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  RobinhoodPhase2Store,
  collectRobinhoodPhase2,
  resolveRobinhoodPhase2Config,
  reviewRobinhoodPhase2Alert,
  robinhoodPhase2Status,
} from "../src/trade/robinhood-chain-phase2.js";
import { runRobinhoodPhase2CollectorJob } from "../src/trade/scheduler.js";

const POOL = `0x${"3".repeat(40)}`;
const TOKEN0 = `0x${"1".repeat(40)}`;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const GMGN_TOKEN = `0x${"a".repeat(40)}`;

function config(overrides: Record<string, unknown> = {}) {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        phase1: {
          enabled: true,
          phase2: {
            enabled: true,
            delivery: "shadow",
            ...overrides,
          },
        },
      },
    },
  };
}

function seedPhase1(
  path: string,
  options: { now: number; state?: "qualified" | "rejected" | "stale"; health?: "ok" | "error"; post?: string },
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE source_health (source TEXT PRIMARY KEY,status TEXT,last_success_at INTEGER);
    CREATE TABLE pools (pool_key TEXT PRIMARY KEY,protocol_id TEXT,token0 TEXT,token1 TEXT);
    CREATE TABLE trend_candidates (
      pool_key TEXT,window_start INTEGER,state TEXT,score REAL,components_json TEXT,evidence_json TEXT,
      PRIMARY KEY(pool_key,window_start)
    );
    CREATE TABLE signal_audit (
      pool_key TEXT,window_start INTEGER,source_first_block INTEGER,source_last_block INTEGER,
      decoder_version TEXT,config_revision TEXT,collection_lane TEXT NOT NULL DEFAULT 'realtime'
    );
    CREATE TABLE account_posts (
      post_id TEXT,handle TEXT,text TEXT,url TEXT,created_at TEXT,fetched_at INTEGER
    );
  `);
  db.prepare("INSERT INTO source_health VALUES ('robinhood_chain_phase1',?,?)").run(
    options.health ?? "ok",
    options.now,
  );
  db.prepare("INSERT INTO pools VALUES (?,?,?,?)").run(POOL, "uniswap_v2", TOKEN0, USDG);
  const windowStart = Math.floor((options.now - 300) / 300) * 300;
  if (options.state !== undefined) {
    db.prepare("INSERT INTO trend_candidates VALUES (?,?,?,?,?,?)").run(
      POOL,
      windowStart,
      options.state,
      82,
      JSON.stringify({ volumeAcceleration: 40 }),
      JSON.stringify({ volumeUsd: 50_000, uniqueTraders: 12 }),
    );
    db.prepare("INSERT INTO signal_audit VALUES (?,?,?,?,?,?,?)").run(
      POOL,
      windowStart,
      100,
      120,
      "phase1-v1",
      "approved-test",
      "realtime",
    );
  }
  if (options.post) {
    db.prepare("INSERT INTO account_posts VALUES (?,?,?,?,?,?)").run(
      "123",
      "RobinhoodCrypto",
      options.post,
      "https://x.com/i/status/123",
      "now",
      options.now,
    );
  }
  db.close();
}

function seedGmgn(path: string, now: number, revision = "phase2-v13-gmgn-primary", verified = 1): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE source_health (
      source TEXT PRIMARY KEY,status TEXT,last_success_at INTEGER,field_run_revision TEXT
    );
    CREATE TABLE gmgn_candidates (
      subject_type TEXT,subject_address TEXT,pool_address TEXT,window_start INTEGER,state TEXT,score REAL,
      evidence_json TEXT,verified INTEGER,field_run_revision TEXT
    );
  `);
  db.prepare("INSERT INTO source_health VALUES ('gmgn','ok',?,?)").run(now, "phase2-v13-gmgn-primary");
  db.prepare("INSERT INTO gmgn_candidates VALUES ('token',?,?,?,?,?,?,?,?)").run(
    GMGN_TOKEN,
    POOL,
    Math.floor((now - 300) / 300) * 300,
    "qualified",
    95,
    JSON.stringify({ volume5mUsd: 50_000, holderCount: 250 }),
    verified,
    revision,
  );
  db.close();
}

function snapshot(now: number, count = 1) {
  return {
    status: "ok" as const,
    lastSuccessAt: now,
    auditedWindows: count,
    candidates: Array.from({ length: count }, (_, index) => ({
      pool_key: `0x${(index + 10).toString(16).padStart(40, "0")}`,
      window_start: 1_699_999_700 - index * 300,
      score: 82 - index,
      components_json: JSON.stringify({ volumeAcceleration: 40 }),
      evidence_json: JSON.stringify({ volumeUsd: 50_000, uniqueTraders: 12 }),
      protocol_id: "uniswap_v2",
      token0: TOKEN0,
      token1: USDG,
      source_first_block: 100,
      source_last_block: 120,
      decoder_version: "phase1-v1",
      config_revision: "approved-test",
    })),
    xPosts: new Map(),
  };
}

describe("Robinhood Chain Phase 2", () => {
  it("keeps the field gate strict and shadow-only", () => {
    const resolved = resolveRobinhoodPhase2Config(
      config({
        source_max_age_seconds: 99999,
        min_observation_hours: 1,
        min_successful_runs: 1,
        max_run_gap_seconds: 99999,
        max_source_error_rate: 1,
        min_audited_windows: 0,
        min_reviewed_alerts: 0,
      }),
    );
    assert.equal(resolved.delivery, "shadow");
    assert.equal(resolved.fieldRunRevision, "phase2-v3-readiness-epoch");
    assert.equal(resolved.sourceMaxAgeSeconds, 600);
    assert.equal(resolved.minObservationHours, 72);
    assert.equal(resolved.minSuccessfulRuns, 800);
    assert.equal(resolved.maxRunGapSeconds, 900);
    assert.equal(resolved.maxSourceErrorRate, 0.05);
    assert.equal(resolved.minAuditedWindows, 1);
    assert.equal(resolved.minReviewedAlerts, 10);
    assert.equal(
      resolveRobinhoodPhase2Config(config({ field_run_revision: "field-2026-08-31-r2" })).fieldRunRevision,
      "field-2026-08-31-r2",
    );
    assert.equal(
      resolveRobinhoodPhase2Config(config({ field_run_revision: "invalid revision" })).fieldRunRevision,
      "phase2-v3-readiness-epoch",
    );
    const gmgn = resolveRobinhoodPhase2Config({
      data_sources: {
        robinhood_chain: {
          enabled: true,
          phase1: { enabled: true, discovery_source: "gmgn", phase2: { enabled: true, delivery: "shadow" } },
        },
      },
    });
    assert.equal(gmgn.fieldRunRevision, "phase2-v13-gmgn-primary");
    assert.throws(() => resolveRobinhoodPhase2Config(config({ delivery: "telegram" })), /shadow/);
  });

  it("does not create a database while disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-disabled-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    try {
      const result = await collectRobinhoodPhase2({ config: {}, phase2DbPath });
      assert.equal(result.status, "disabled");
      await assert.rejects(() => access(phase2DbPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when Phase 1 is missing or unhealthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-source-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      const missing = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      assert.equal(missing.status, "source_unavailable");
      assert.equal(missing.draftsMaterialized, 0);

      seedPhase1(phase1DbPath, { now, state: "qualified", health: "error" });
      const unhealthy = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      assert.equal(unhealthy.status, "source_unhealthy");
      assert.equal(unhealthy.draftsMaterialized, 0);
      assert.equal(unhealthy.readiness?.liveDeliveryAuthorized, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when Phase 1 has no realtime provenance column", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-legacy-provenance-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    const db = new DatabaseSync(phase1DbPath);
    db.exec(`
      CREATE TABLE source_health (source TEXT PRIMARY KEY,status TEXT,last_success_at INTEGER);
      CREATE TABLE signal_audit (window_start INTEGER);
    `);
    db.prepare("INSERT INTO source_health VALUES ('robinhood_chain_phase1','ok',?)").run(now);
    db.close();
    try {
      const result = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      assert.equal(result.status, "source_unavailable");
      assert.equal(result.draftsMaterialized, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("materializes qualified candidates idempotently and only enriches exact address matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-materialize-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      seedPhase1(phase1DbPath, { now, state: "qualified", post: `Pool update ${POOL}` });
      const first = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      const second = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now: now + 300 });
      assert.equal(first.status, "persisted");
      assert.equal(first.draftsMaterialized, 1);
      assert.equal(second.draftsMaterialized, 1);
      const store = new RobinhoodPhase2Store(phase2DbPath);
      assert.equal(store.count("shadow_alerts"), 1);
      assert.equal(store.count("phase2_runs"), 2);
      const alert = store.listAlerts(1)[0]!;
      const full = store.getAlert(String(alert.alert_id))!;
      const evidence = JSON.parse(String(full.evidence_json)) as { matchedXPosts: unknown[] };
      assert.equal(evidence.matchedXPosts.length, 1);
      assert.match(String(full.message), /not a trading instruction/);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("materializes only verified v13 GMGN subjects and enriches exact token addresses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-gmgn-"));
    const gmgnDbPath = join(dir, "gmgn.sqlite");
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    const gmgnConfig = {
      data_sources: {
        robinhood_chain: {
          enabled: true,
          phase1: {
            enabled: true,
            discovery_source: "gmgn",
            phase2: { enabled: true, delivery: "shadow" },
          },
        },
      },
    };
    try {
      seedGmgn(gmgnDbPath, now);
      const xDb = new DatabaseSync(phase1DbPath);
      xDb.exec(
        "CREATE TABLE account_posts (post_id TEXT,handle TEXT,text TEXT,url TEXT,created_at TEXT,fetched_at INTEGER)",
      );
      xDb
        .prepare("INSERT INTO account_posts VALUES (?,?,?,?,?,?)")
        .run(
          "gmgn-post",
          "RobinhoodCrypto",
          `Token update ${GMGN_TOKEN}`,
          "https://x.com/i/status/gmgn-post",
          "now",
          now,
        );
      xDb.close();
      const result = await collectRobinhoodPhase2({
        config: gmgnConfig,
        gmgnDbPath,
        phase1DbPath,
        phase2DbPath,
        now,
      });
      assert.equal(result.status, "persisted");
      assert.equal(result.draftsMaterialized, 1);
      const store = new RobinhoodPhase2Store(phase2DbPath);
      const alert = store.getAlert(String(store.listAlerts(1)[0]!.alert_id))!;
      assert.equal(alert.subject_type, "token");
      assert.equal(alert.subject_address, GMGN_TOKEN);
      assert.equal(alert.pool_address, POOL);
      assert.equal(alert.source_kind, "gmgn");
      assert.equal(alert.field_run_revision, "phase2-v13-gmgn-primary");
      assert.equal((JSON.parse(String(alert.evidence_json)) as { matchedXPosts: unknown[] }).matchedXPosts.length, 1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not materialize legacy GMGN candidates into the v13 epoch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-gmgn-legacy-"));
    const gmgnDbPath = join(dir, "gmgn.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      seedGmgn(gmgnDbPath, now, "phase2-v12-rpc");
      const result = await collectRobinhoodPhase2({
        config: {
          data_sources: {
            robinhood_chain: {
              enabled: true,
              phase1: {
                enabled: true,
                discovery_source: "gmgn",
                phase2: { enabled: true, delivery: "shadow" },
              },
            },
          },
        },
        gmgnDbPath,
        phase2DbPath,
        now,
      });
      assert.equal(result.status, "persisted");
      assert.equal(result.draftsMaterialized, 0);
      assert.equal(result.readiness?.auditedWindows, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not materialize an unverified v13 GMGN candidate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-gmgn-unverified-"));
    const gmgnDbPath = join(dir, "gmgn.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      seedGmgn(gmgnDbPath, now, "phase2-v13-gmgn-primary", 0);
      const result = await collectRobinhoodPhase2({
        config: {
          data_sources: {
            robinhood_chain: {
              enabled: true,
              phase1: {
                enabled: true,
                discovery_source: "gmgn",
                phase2: { enabled: true, delivery: "shadow" },
              },
            },
          },
        },
        gmgnDbPath,
        phase2DbPath,
        now,
      });
      assert.equal(result.status, "persisted");
      assert.equal(result.draftsMaterialized, 0);
      assert.equal(result.readiness?.auditedWindows, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not let X-only observations create a shadow draft", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-x-only-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      seedPhase1(phase1DbPath, { now, post: `Pool update ${POOL}` });
      const result = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      assert.equal(result.status, "persisted");
      assert.equal(result.draftsMaterialized, 0);
      const store = new RobinhoodPhase2Store(phase2DbPath);
      assert.equal(store.count("shadow_alerts"), 0);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains backfill audits without materializing them as realtime drafts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-backfill-isolation-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    const db = new DatabaseSync(phase1DbPath);
    db.exec(`
      CREATE TABLE source_health (source TEXT PRIMARY KEY,status TEXT,last_success_at INTEGER);
      CREATE TABLE pools (pool_key TEXT PRIMARY KEY,protocol_id TEXT,token0 TEXT,token1 TEXT);
      CREATE TABLE trend_candidates (
        pool_key TEXT,window_start INTEGER,state TEXT,score REAL,components_json TEXT,evidence_json TEXT,
        collection_lane TEXT NOT NULL DEFAULT 'legacy',PRIMARY KEY(pool_key,window_start)
      );
      CREATE TABLE signal_audit (
        pool_key TEXT,window_start INTEGER,source_first_block INTEGER,source_last_block INTEGER,
        decoder_version TEXT,config_revision TEXT,collection_lane TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE TABLE account_posts (post_id TEXT,handle TEXT,text TEXT,url TEXT,created_at TEXT,fetched_at INTEGER);
    `);
    db.prepare("INSERT INTO source_health VALUES ('robinhood_chain_phase1','ok',?)").run(now);
    const windowStart = Math.floor((now - 300) / 300) * 300;
    for (const [index, lane] of ["realtime", "backfill"].entries()) {
      const pool = `0x${(index + 20).toString(16).padStart(40, "0")}`;
      db.prepare("INSERT INTO pools VALUES (?,?,?,?)").run(pool, "uniswap_v2", TOKEN0, USDG);
      db.prepare("INSERT INTO trend_candidates VALUES (?,?,?,?,?,?,?)").run(
        pool,
        windowStart - index * 300,
        "qualified",
        82,
        "{}",
        JSON.stringify({ volumeUsd: 50_000, uniqueTraders: 12 }),
        lane,
      );
      db.prepare("INSERT INTO signal_audit VALUES (?,?,?,?,?,?,?)").run(
        pool,
        windowStart - index * 300,
        100,
        120,
        "phase1-v1",
        "approved-test",
        lane,
      );
    }
    db.close();
    try {
      const result = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      const store = new RobinhoodPhase2Store(phase2DbPath);
      assert.equal(result.status, "persisted");
      assert.equal(result.draftsMaterialized, 1);
      assert.equal(store.count("shadow_alerts"), 1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stales an existing draft when the Phase 1 source becomes unhealthy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-stale-"));
    const phase1DbPath = join(dir, "phase1.sqlite");
    const phase2DbPath = join(dir, "phase2.sqlite");
    const now = 1_700_000_000;
    try {
      seedPhase1(phase1DbPath, { now, state: "qualified" });
      await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now });
      const db = new DatabaseSync(phase1DbPath);
      db.prepare("UPDATE source_health SET status='error'").run();
      db.close();
      const result = await collectRobinhoodPhase2({ config: config(), phase1DbPath, phase2DbPath, now: now + 300 });
      assert.equal(result.status, "source_unhealthy");
      assert.equal(result.draftsStaled, 1);
      const store = new RobinhoodPhase2Store(phase2DbPath);
      assert.equal(store.listAlerts(1)[0]!.state, "stale");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires 72-hour coverage, 800 runs, and ten reviews before approval is requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-readiness-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    const store = new RobinhoodPhase2Store(phase2DbPath);
    const cfg = resolveRobinhoodPhase2Config(config());
    const startedAt = 1_700_000_000;
    try {
      for (let index = 0; index < 800; index += 1) {
        const now = startedAt + index * 325;
        store.materialize({ now, cfg, snapshot: snapshot(now, 10) });
      }
      const beforeReview = store.computeReadiness(cfg);
      assert.equal(beforeReview.state, "review_samples_required");
      assert.deepEqual(beforeReview.reasons, ["reviewed_alerts_below_minimum"]);
      for (const alert of store.listAlerts(20).slice(0, 10)) {
        store.reviewAlert(String(alert.alert_id), "accepted", "reviewed against the deterministic evidence");
      }
      const afterReview = store.computeReadiness(cfg);
      assert.equal(afterReview.state, "approval_required");
      assert.deepEqual(afterReview.reasons, []);
      assert.equal(afterReview.liveDeliveryAuthorized, false);
      store.materialize({
        now: startedAt + 800 * 325,
        cfg,
        snapshot: { status: "unhealthy", lastSuccessAt: null, auditedWindows: 0, candidates: [], xPosts: new Map() },
      });
      const afterSourceFailure = store.computeReadiness(cfg);
      assert.equal(afterSourceFailure.state, "collecting");
      assert.ok(afterSourceFailure.reasons.includes("latest_source_unhealthy"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps readiness collecting when run gaps or source errors exceed the gate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-fail-gate-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    const store = new RobinhoodPhase2Store(phase2DbPath);
    const cfg = {
      ...resolveRobinhoodPhase2Config(config()),
      minObservationHours: 0.1,
      minSuccessfulRuns: 2,
      maxRunGapSeconds: 100,
      maxSourceErrorRate: 0.1,
      minReviewedAlerts: 0,
    };
    try {
      store.materialize({ now: 1_700_000_000, cfg, snapshot: snapshot(1_700_000_000) });
      store.materialize({ now: 1_700_000_050, cfg, snapshot: snapshot(1_700_000_050) });
      store.materialize({
        now: 1_700_000_500,
        cfg,
        snapshot: { status: "unhealthy", lastSuccessAt: null, auditedWindows: 0, candidates: [], xPosts: new Map() },
      });
      const readiness = store.computeReadiness(cfg);
      assert.equal(readiness.state, "collecting");
      assert.ok(readiness.reasons.includes("run_gap_above_maximum"));
      assert.ok(readiness.reasons.includes("source_error_rate_above_maximum"));
      assert.ok(readiness.reasons.includes("latest_source_unhealthy"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates readiness, alerts, and reviews by field-run revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-revision-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    const store = new RobinhoodPhase2Store(phase2DbPath);
    const base = {
      ...resolveRobinhoodPhase2Config(config()),
      minObservationHours: 0,
      minSuccessfulRuns: 1,
      minReviewedAlerts: 0,
    };
    const revisionA = { ...base, fieldRunRevision: "revision-a" };
    const revisionB = { ...base, fieldRunRevision: "revision-b" };
    try {
      store.materialize({ now: 1_700_000_000, cfg: revisionA, snapshot: snapshot(1_700_000_000) });
      store.materialize({ now: 1_700_000_300, cfg: revisionA, snapshot: snapshot(1_700_000_300) });
      const alertA = String(store.listAlerts(1, revisionA.fieldRunRevision)[0]!.alert_id);
      store.reviewAlert(alertA, "accepted", "reviewed under revision A");
      assert.equal(store.computeReadiness(revisionA).totalRuns, 2);
      assert.equal(store.computeReadiness(revisionA).reviewedAlerts, 1);

      store.materialize({ now: 1_700_000_600, cfg: revisionB, snapshot: snapshot(1_700_000_600) });
      const readinessB = store.computeReadiness(revisionB);
      assert.equal(readinessB.fieldRunRevision, "revision-b");
      assert.equal(readinessB.totalRuns, 1);
      assert.equal(readinessB.observationHours, 0);
      assert.equal(readinessB.reviewedAlerts, 0);
      assert.equal(readinessB.shadowAlerts, 1);
      assert.equal(store.listAlerts(10, revisionB.fieldRunRevision).length, 1);
      assert.notEqual(store.listAlerts(1, revisionB.fieldRunRevision)[0]!.alert_id, alertA);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy Phase 2 runs without counting them toward the current revision", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-legacy-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    const db = new DatabaseSync(phase2DbPath);
    db.exec(`
      CREATE TABLE phase2_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,status TEXT NOT NULL,
        phase1_status TEXT NOT NULL,phase1_last_success_at INTEGER,candidate_count INTEGER NOT NULL,
        audit_count INTEGER NOT NULL,error_code TEXT
      );
      INSERT INTO phase2_runs
      (started_at,status,phase1_status,phase1_last_success_at,candidate_count,audit_count,error_code)
      VALUES (1700000000,'ok','ok',1700000000,0,20,NULL);
    `);
    db.close();
    const cfg = resolveRobinhoodPhase2Config(config());
    const store = new RobinhoodPhase2Store(phase2DbPath);
    try {
      assert.equal(store.count("phase2_runs"), 1);
      const readiness = store.computeReadiness(cfg);
      assert.equal(readiness.fieldRunRevision, "phase2-v3-readiness-epoch");
      assert.equal(readiness.totalRuns, 0);
      assert.equal(readiness.auditedWindows, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records bounded explicit reviews and reports status without delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p2-review-"));
    const phase2DbPath = join(dir, "phase2.sqlite");
    const store = new RobinhoodPhase2Store(phase2DbPath);
    const cfg = resolveRobinhoodPhase2Config(config());
    try {
      store.materialize({ now: 1_700_000_000, cfg, snapshot: snapshot(1_700_000_000) });
      const alertId = String(store.listAlerts(1)[0]!.alert_id);
      store.close();
      assert.throws(
        () => reviewRobinhoodPhase2Alert({ alertId, verdict: "maybe", phase2DbPath }),
        /accepted or rejected/,
      );
      reviewRobinhoodPhase2Alert({ alertId, verdict: "rejected", note: "x".repeat(2000), phase2DbPath });
      reviewRobinhoodPhase2Alert({ alertId, verdict: "accepted", note: "second review", phase2DbPath });
      const status = robinhoodPhase2Status({ config: config(), phase2DbPath });
      assert.equal(status.alerts[0]!.verdict, "accepted");
      assert.equal(status.alerts[0]!.note, "second review");
      assert.equal(status.readiness?.liveDeliveryAuthorized, false);
      const reopened = new RobinhoodPhase2Store(phase2DbPath);
      assert.equal(reopened.count("alert_reviews"), 2);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates Phase 2 collector failures from the daemon scheduler", async () => {
    const lines: string[] = [];
    await runRobinhoodPhase2CollectorJob(
      config(),
      async () => {
        throw new Error("phase2 database offline");
      },
      (line) => lines.push(line),
    );
    assert.deepEqual(lines, ["[robinhood-phase2] failed: phase2 database offline"]);
  });
});
