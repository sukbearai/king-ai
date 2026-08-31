import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ROBINHOOD_CHAIN_PHASE1_DB_PATH, ROBINHOOD_CHAIN_PHASE2_DB_PATH } from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import { closeSqliteDb, openSqliteDb, sqliteDbExists } from "./sqlite-db.js";

const DEFAULT_FIELD_RUN_REVISION = "phase2-v3-readiness-epoch";

export interface RobinhoodPhase2Config {
  enabled: boolean;
  delivery: "shadow";
  fieldRunRevision: string;
  collectSeconds: number;
  lookbackHours: number;
  sourceMaxAgeSeconds: number;
  minObservationHours: number;
  minSuccessfulRuns: number;
  maxRunGapSeconds: number;
  maxSourceErrorRate: number;
  minAuditedWindows: number;
  minReviewedAlerts: number;
  maxCandidatesPerRun: number;
  retentionDays: number;
}

export type RobinhoodPhase2ReadinessState = "collecting" | "review_samples_required" | "approval_required";

export interface RobinhoodPhase2Readiness {
  state: RobinhoodPhase2ReadinessState;
  reasons: string[];
  fieldRunRevision: string;
  observationHours: number;
  totalRuns: number;
  successfulRuns: number;
  sourceErrorRate: number;
  maxRunGapSeconds: number;
  auditedWindows: number;
  reviewedAlerts: number;
  shadowAlerts: number;
  liveDeliveryAuthorized: false;
}

export interface RobinhoodPhase2Result {
  status: "disabled" | "source_unavailable" | "source_unhealthy" | "persisted";
  delivery: "shadow";
  draftsMaterialized: number;
  draftsStaled: number;
  readiness?: RobinhoodPhase2Readiness;
}

interface Phase1CandidateRow {
  pool_key: string;
  window_start: number;
  score: number;
  components_json: string;
  evidence_json: string;
  protocol_id: string;
  token0: string;
  token1: string;
  source_first_block: number;
  source_last_block: number;
  decoder_version: string;
  config_revision: string;
}

interface Phase1Snapshot {
  status: "ok" | "unavailable" | "unhealthy";
  lastSuccessAt: number | null;
  auditedWindows: number;
  candidates: Phase1CandidateRow[];
  xPosts: Map<string, Array<{ id: string; handle: string; text: string; url: string; createdAt: string }>>;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function fieldRunRevision(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(normalized) ? normalized : DEFAULT_FIELD_RUN_REVISION;
}

export function resolveRobinhoodPhase2Config(config: TradeConfig): RobinhoodPhase2Config {
  const raw = (dotGet(config, "data_sources.robinhood_chain.phase1.phase2", {}) ?? {}) as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const delivery = String(raw.delivery ?? "shadow");
  if (enabled && delivery !== "shadow") throw new Error("Robinhood Chain Phase 2 supports shadow delivery only");
  return {
    enabled,
    delivery: "shadow",
    fieldRunRevision: fieldRunRevision(raw.field_run_revision),
    collectSeconds: boundedInt(raw.collect_seconds, 300, 60, 86400),
    lookbackHours: boundedInt(raw.lookback_hours, 24, 1, 168),
    sourceMaxAgeSeconds: boundedInt(raw.source_max_age_seconds, 600, 60, 600),
    minObservationHours: boundedInt(raw.min_observation_hours, 72, 72, 720),
    minSuccessfulRuns: boundedInt(raw.min_successful_runs, 800, 800, 10000),
    maxRunGapSeconds: boundedInt(raw.max_run_gap_seconds, 900, 60, 900),
    maxSourceErrorRate: boundedNumber(raw.max_source_error_rate, 0.05, 0, 0.05),
    minAuditedWindows: boundedInt(raw.min_audited_windows, 1, 1, 1_000_000),
    minReviewedAlerts: boundedInt(raw.min_reviewed_alerts, 10, 10, 10_000),
    maxCandidatesPerRun: boundedInt(raw.max_candidates_per_run, 100, 1, 500),
    retentionDays: boundedInt(raw.retention_days, 30, 7, 90),
  };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function alertId(row: Phase1CandidateRow, fieldRunRevision: string): string {
  return createHash("sha256")
    .update(`${row.pool_key}:${row.window_start}:${row.config_revision}:${fieldRunRevision}`)
    .digest("hex")
    .slice(0, 32);
}

function strength(score: number): "strong" | "moderate" | "watch" {
  if (score >= 80) return "strong";
  if (score >= 65) return "moderate";
  return "watch";
}

function draftMessage(row: Phase1CandidateRow): string {
  const evidence = safeJson(row.evidence_json);
  const volume = Number(evidence.volumeUsd ?? 0);
  const traders = Number(evidence.uniqueTraders ?? 0);
  return [
    `Robinhood Chain shadow trend (${strength(row.score)})`,
    `protocol=${row.protocol_id} pool=${row.pool_key}`,
    `score=${row.score.toFixed(2)} volume_5m_usd=${volume.toFixed(2)} unique_traders=${traders}`,
    `window_start=${row.window_start} blocks=${row.source_first_block}-${row.source_last_block}`,
    "Shadow evidence only; not a trading instruction.",
  ].join("\n");
}

function readPhase1Snapshot(path: string, now: number, cfg: RobinhoodPhase2Config): Phase1Snapshot {
  if (!sqliteDbExists(path)) {
    return { status: "unavailable", lastSuccessAt: null, auditedWindows: 0, candidates: [], xPosts: new Map() };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const health = db
      .prepare("SELECT status,last_success_at FROM source_health WHERE source='robinhood_chain_phase1'")
      .get() as { status?: string; last_success_at?: number | null } | undefined;
    const lastSuccessAt = health?.last_success_at == null ? null : Number(health.last_success_at);
    if (
      health?.status !== "ok" ||
      lastSuccessAt == null ||
      !Number.isFinite(lastSuccessAt) ||
      lastSuccessAt > now + 60 ||
      now - lastSuccessAt > cfg.sourceMaxAgeSeconds
    ) {
      return { status: "unhealthy", lastSuccessAt, auditedWindows: 0, candidates: [], xPosts: new Map() };
    }
    const since = now - cfg.lookbackHours * 3600;
    const auditRow = db.prepare("SELECT COUNT(*) AS count FROM signal_audit WHERE window_start>=?").get(since) as {
      count?: number;
    };
    const candidates = db
      .prepare(`
        SELECT tc.pool_key,tc.window_start,tc.score,tc.components_json,tc.evidence_json,
               p.protocol_id,p.token0,p.token1,sa.source_first_block,sa.source_last_block,
               sa.decoder_version,sa.config_revision
        FROM trend_candidates tc
        JOIN pools p ON p.pool_key=tc.pool_key
        JOIN signal_audit sa ON sa.pool_key=tc.pool_key AND sa.window_start=tc.window_start
        WHERE tc.state='qualified' AND tc.window_start>=?
        ORDER BY tc.score DESC,tc.window_start DESC LIMIT ?
      `)
      .all(since, cfg.maxCandidatesPerRun) as unknown as Phase1CandidateRow[];
    const xPosts = new Map<
      string,
      Array<{ id: string; handle: string; text: string; url: string; createdAt: string }>
    >();
    const postQuery = db.prepare(`
      SELECT post_id,handle,text,url,created_at FROM account_posts
      WHERE fetched_at>=? AND (lower(text) LIKE ? OR lower(text) LIKE ? OR lower(text) LIKE ?)
      ORDER BY fetched_at DESC LIMIT 3
    `);
    for (const candidate of candidates) {
      const rows = postQuery.all(
        since,
        `%${candidate.pool_key.toLowerCase()}%`,
        `%${candidate.token0.toLowerCase()}%`,
        `%${candidate.token1.toLowerCase()}%`,
      ) as Array<Record<string, unknown>>;
      xPosts.set(
        `${candidate.pool_key}:${candidate.window_start}`,
        rows.map((row) => ({
          id: String(row.post_id),
          handle: String(row.handle),
          text: String(row.text).slice(0, 1000),
          url: String(row.url).slice(0, 1000),
          createdAt: String(row.created_at).slice(0, 100),
        })),
      );
    }
    return {
      status: "ok",
      lastSuccessAt,
      auditedWindows: Number(auditRow.count ?? 0),
      candidates,
      xPosts,
    };
  } catch {
    return { status: "unavailable", lastSuccessAt: null, auditedWindows: 0, candidates: [], xPosts: new Map() };
  } finally {
    db.close();
  }
}

export class RobinhoodPhase2Store {
  private readonly db;

  constructor(readonly path: string) {
    this.db = openSqliteDb(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS phase2_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT,started_at INTEGER NOT NULL,status TEXT NOT NULL,
        phase1_status TEXT NOT NULL,phase1_last_success_at INTEGER,candidate_count INTEGER NOT NULL,
        audit_count INTEGER NOT NULL,error_code TEXT,field_run_revision TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE INDEX IF NOT EXISTS phase2_runs_started_idx ON phase2_runs(started_at);
      CREATE TABLE IF NOT EXISTS shadow_alerts (
        alert_id TEXT PRIMARY KEY,pool_key TEXT NOT NULL,window_start INTEGER NOT NULL,protocol_id TEXT NOT NULL,
        token0 TEXT NOT NULL,token1 TEXT NOT NULL,score REAL NOT NULL,strength TEXT NOT NULL,state TEXT NOT NULL,
        message TEXT NOT NULL,evidence_json TEXT NOT NULL,first_materialized_at INTEGER NOT NULL,
        last_materialized_at INTEGER NOT NULL,field_run_revision TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE INDEX IF NOT EXISTS shadow_alerts_state_idx ON shadow_alerts(state,last_materialized_at);
      CREATE TABLE IF NOT EXISTS alert_reviews (
        review_id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id TEXT NOT NULL REFERENCES shadow_alerts(alert_id) ON DELETE CASCADE,verdict TEXT NOT NULL,
        note TEXT NOT NULL,reviewer TEXT NOT NULL,reviewed_at INTEGER NOT NULL,
        field_run_revision TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE INDEX IF NOT EXISTS alert_reviews_alert_idx ON alert_reviews(alert_id,reviewed_at,review_id);
      CREATE TABLE IF NOT EXISTS readiness_checks (
        check_id INTEGER PRIMARY KEY AUTOINCREMENT,checked_at INTEGER NOT NULL,state TEXT NOT NULL,
        reasons_json TEXT NOT NULL,metrics_json TEXT NOT NULL,field_run_revision TEXT NOT NULL DEFAULT 'legacy'
      );
    `);
    this.ensureColumn("phase2_runs", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("shadow_alerts", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("alert_reviews", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("readiness_checks", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS phase2_runs_revision_started_idx
      ON phase2_runs(field_run_revision,started_at);
      CREATE INDEX IF NOT EXISTS shadow_alerts_revision_state_idx
      ON shadow_alerts(field_run_revision,state,last_materialized_at);
      CREATE INDEX IF NOT EXISTS alert_reviews_revision_alert_idx
      ON alert_reviews(field_run_revision,alert_id,reviewed_at,review_id);
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  materialize(input: { now: number; cfg: RobinhoodPhase2Config; snapshot: Phase1Snapshot }): {
    materialized: number;
    staled: number;
    readiness: RobinhoodPhase2Readiness;
  } {
    const { now, cfg, snapshot } = input;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const activeIds = new Set(
        (
          this.db
            .prepare("SELECT alert_id FROM shadow_alerts WHERE state='draft' AND field_run_revision=?")
            .all(cfg.fieldRunRevision) as Array<{ alert_id: string }>
        ).map((row) => row.alert_id),
      );
      this.db.prepare("UPDATE shadow_alerts SET state='stale' WHERE state='draft'").run();
      let materialized = 0;
      const currentIds = new Set<string>();
      if (snapshot.status === "ok") {
        const upsert = this.db.prepare(`
          INSERT INTO shadow_alerts (
            alert_id,pool_key,window_start,protocol_id,token0,token1,score,strength,state,message,evidence_json,
            first_materialized_at,last_materialized_at,field_run_revision
          ) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)
          ON CONFLICT(alert_id) DO UPDATE SET score=excluded.score,strength=excluded.strength,state='draft',
          message=excluded.message,evidence_json=excluded.evidence_json,last_materialized_at=excluded.last_materialized_at,
          field_run_revision=excluded.field_run_revision
        `);
        for (const row of snapshot.candidates) {
          const id = alertId(row, cfg.fieldRunRevision);
          currentIds.add(id);
          const evidence = {
            phase1: {
              candidate: safeJson(row.evidence_json),
              components: safeJson(row.components_json),
              sourceFirstBlock: row.source_first_block,
              sourceLastBlock: row.source_last_block,
              decoderVersion: row.decoder_version,
              configRevision: row.config_revision,
            },
            matchedXPosts: snapshot.xPosts.get(`${row.pool_key}:${row.window_start}`) ?? [],
          };
          upsert.run(
            id,
            row.pool_key,
            row.window_start,
            row.protocol_id,
            row.token0,
            row.token1,
            row.score,
            strength(row.score),
            draftMessage(row),
            JSON.stringify(evidence),
            now,
            now,
            cfg.fieldRunRevision,
          );
          materialized += 1;
        }
      }
      this.db
        .prepare(`
          INSERT INTO phase2_runs (
            started_at,status,phase1_status,phase1_last_success_at,candidate_count,audit_count,error_code,
            field_run_revision
          ) VALUES (?,?,?,?,?,?,?,?)
        `)
        .run(
          now,
          snapshot.status === "ok" ? "ok" : "source_error",
          snapshot.status,
          snapshot.lastSuccessAt,
          snapshot.candidates.length,
          snapshot.auditedWindows,
          snapshot.status === "ok" ? null : `phase1_${snapshot.status}`,
          cfg.fieldRunRevision,
        );
      const cutoff = now - cfg.retentionDays * 86400;
      this.db.prepare("DELETE FROM phase2_runs WHERE started_at<?").run(cutoff);
      this.db.prepare("DELETE FROM readiness_checks WHERE checked_at<?").run(cutoff);
      this.db.prepare("DELETE FROM shadow_alerts WHERE state='stale' AND last_materialized_at<?").run(cutoff);
      const staled = [...activeIds].filter((id) => !currentIds.has(id)).length;
      const readiness = this.computeReadiness(cfg);
      this.db
        .prepare(
          `INSERT INTO readiness_checks
           (checked_at,state,reasons_json,metrics_json,field_run_revision) VALUES (?,?,?,?,?)`,
        )
        .run(now, readiness.state, JSON.stringify(readiness.reasons), JSON.stringify(readiness), cfg.fieldRunRevision);
      this.db.exec("COMMIT");
      return { materialized, staled, readiness };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  computeReadiness(cfg: RobinhoodPhase2Config): RobinhoodPhase2Readiness {
    const runs = this.db
      .prepare("SELECT started_at,status,audit_count FROM phase2_runs WHERE field_run_revision=? ORDER BY started_at")
      .all(cfg.fieldRunRevision) as Array<{
      started_at: number;
      status: string;
      audit_count: number;
    }>;
    const totalRuns = runs.length;
    const successfulRuns = runs.filter((row) => row.status === "ok").length;
    const observationHours = totalRuns > 1 ? (runs.at(-1)!.started_at - runs[0]!.started_at) / 3600 : 0;
    let maxGapSeconds = 0;
    for (let index = 1; index < runs.length; index += 1) {
      maxGapSeconds = Math.max(maxGapSeconds, runs[index]!.started_at - runs[index - 1]!.started_at);
    }
    const sourceErrorRate = totalRuns ? (totalRuns - successfulRuns) / totalRuns : 1;
    const auditedWindows = runs.reduce((max, row) => Math.max(max, Number(row.audit_count ?? 0)), 0);
    const reviewedRow = this.db
      .prepare("SELECT COUNT(DISTINCT alert_id) AS count FROM alert_reviews WHERE field_run_revision=?")
      .get(cfg.fieldRunRevision) as { count?: number };
    const alertRow = this.db
      .prepare("SELECT COUNT(*) AS count FROM shadow_alerts WHERE field_run_revision=?")
      .get(cfg.fieldRunRevision) as { count?: number };
    const reviewedAlerts = Number(reviewedRow.count ?? 0);
    const shadowAlerts = Number(alertRow.count ?? 0);
    const reasons: string[] = [];
    if (observationHours < cfg.minObservationHours) reasons.push("observation_period_short");
    if (successfulRuns < cfg.minSuccessfulRuns) reasons.push("successful_runs_below_minimum");
    if (totalRuns > 1 && maxGapSeconds > cfg.maxRunGapSeconds) reasons.push("run_gap_above_maximum");
    if (sourceErrorRate > cfg.maxSourceErrorRate) reasons.push("source_error_rate_above_maximum");
    if (runs.at(-1)?.status !== "ok") reasons.push("latest_source_unhealthy");
    if (auditedWindows < cfg.minAuditedWindows) reasons.push("audited_windows_below_minimum");
    const operationalReasons = reasons.length;
    if (reviewedAlerts < cfg.minReviewedAlerts) reasons.push("reviewed_alerts_below_minimum");
    const state: RobinhoodPhase2ReadinessState = operationalReasons
      ? "collecting"
      : reviewedAlerts < cfg.minReviewedAlerts
        ? "review_samples_required"
        : "approval_required";
    return {
      state,
      reasons,
      fieldRunRevision: cfg.fieldRunRevision,
      observationHours: Math.round(observationHours * 100) / 100,
      totalRuns,
      successfulRuns,
      sourceErrorRate: Math.round(sourceErrorRate * 10000) / 10000,
      maxRunGapSeconds: maxGapSeconds,
      auditedWindows,
      reviewedAlerts,
      shadowAlerts,
      liveDeliveryAuthorized: false,
    };
  }

  reviewAlert(alertId: string, verdict: "accepted" | "rejected", note: string, reviewer = "local-human"): void {
    const alert = this.db.prepare("SELECT field_run_revision FROM shadow_alerts WHERE alert_id=?").get(alertId) as
      | { field_run_revision?: string }
      | undefined;
    if (!alert) throw new Error("unknown Robinhood Phase 2 alert id");
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(`
        INSERT INTO alert_reviews (alert_id,verdict,note,reviewer,reviewed_at,field_run_revision)
        VALUES (?,?,?,?,?,?)
      `)
      .run(
        alertId,
        verdict,
        note.trim().slice(0, 1000),
        reviewer.trim().slice(0, 100) || "local-human",
        now,
        String(alert.field_run_revision ?? "legacy"),
      );
  }

  count(table: "phase2_runs" | "shadow_alerts" | "alert_reviews" | "readiness_checks"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number };
    return Number(row.count ?? 0);
  }

  getAlert(alertId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT * FROM shadow_alerts WHERE alert_id=?").get(alertId) as
      | Record<string, unknown>
      | undefined;
    return row ?? null;
  }

  listAlerts(limit = 20, fieldRunRevision?: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`
        SELECT a.alert_id,a.pool_key,a.window_start,a.protocol_id,a.score,a.strength,a.state,a.message,
               r.verdict,r.note,r.reviewed_at
        FROM shadow_alerts a LEFT JOIN alert_reviews r ON r.review_id=(
          SELECT review_id FROM alert_reviews WHERE alert_id=a.alert_id
          ORDER BY reviewed_at DESC,review_id DESC LIMIT 1
        )
        WHERE (? IS NULL OR a.field_run_revision=?)
        ORDER BY a.last_materialized_at DESC,a.score DESC LIMIT ?
      `)
      .all(fieldRunRevision ?? null, fieldRunRevision ?? null, Math.min(100, Math.max(1, Math.trunc(limit)))) as Array<
      Record<string, unknown>
    >;
  }

  close(): void {
    closeSqliteDb(this.path);
  }
}

export async function collectRobinhoodPhase2(options: {
  config: TradeConfig;
  phase1DbPath?: string;
  phase2DbPath?: string;
  force?: boolean;
  now?: number;
}): Promise<RobinhoodPhase2Result> {
  const cfg = resolveRobinhoodPhase2Config(options.config);
  if (!cfg.enabled && !options.force) {
    return { status: "disabled", delivery: "shadow", draftsMaterialized: 0, draftsStaled: 0 };
  }
  const phase2DbPath = options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH;
  await mkdir(dirname(phase2DbPath), { recursive: true });
  const store = new RobinhoodPhase2Store(phase2DbPath);
  try {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const snapshot = readPhase1Snapshot(options.phase1DbPath ?? ROBINHOOD_CHAIN_PHASE1_DB_PATH, now, cfg);
    const result = store.materialize({ now, cfg, snapshot });
    return {
      status:
        snapshot.status === "ok"
          ? "persisted"
          : snapshot.status === "unhealthy"
            ? "source_unhealthy"
            : "source_unavailable",
      delivery: "shadow",
      draftsMaterialized: result.materialized,
      draftsStaled: Math.max(0, result.staled),
      readiness: result.readiness,
    };
  } finally {
    store.close();
  }
}

export function reviewRobinhoodPhase2Alert(options: {
  alertId: string;
  verdict: string;
  note?: string;
  reviewer?: string;
  phase2DbPath?: string;
}): void {
  if (options.verdict !== "accepted" && options.verdict !== "rejected") {
    throw new Error("Robinhood Phase 2 verdict must be accepted or rejected");
  }
  const path = options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH;
  if (!sqliteDbExists(path)) throw new Error("Robinhood Phase 2 database does not exist");
  const store = new RobinhoodPhase2Store(path);
  try {
    store.reviewAlert(options.alertId, options.verdict, options.note ?? "", options.reviewer);
  } finally {
    store.close();
  }
}

export function robinhoodPhase2Status(options: { config: TradeConfig; phase2DbPath?: string; limit?: number }): {
  readiness: RobinhoodPhase2Readiness | null;
  alerts: Array<Record<string, unknown>>;
} {
  const path = options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH;
  if (!sqliteDbExists(path)) return { readiness: null, alerts: [] };
  const store = new RobinhoodPhase2Store(path);
  try {
    const cfg = resolveRobinhoodPhase2Config(options.config);
    return {
      readiness: store.computeReadiness(cfg),
      alerts: store.listAlerts(options.limit, cfg.fieldRunRevision),
    };
  } finally {
    store.close();
  }
}
