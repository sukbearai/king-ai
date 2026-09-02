import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ROBINHOOD_CHAIN_GMGN_DB_PATH,
  ROBINHOOD_CHAIN_PHASE1_DB_PATH,
  ROBINHOOD_CHAIN_PHASE2_DB_PATH,
} from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import { GMGN_FIELD_RUN_REVISION, normalizeGmgnProjectXHandle } from "./robinhood-chain-gmgn.js";
import { closeSqliteDb, openSqliteDb, sqliteDbExists } from "./sqlite-db.js";
import { sendTelegramSingle, TG_MAX_LEN, type TelegramSingleSendResult } from "./telegram.js";

const DEFAULT_FIELD_RUN_REVISION = "phase2-v3-readiness-epoch";

export interface RobinhoodPhase2Config {
  enabled: boolean;
  delivery: "shadow" | "telegram";
  fieldRunRevision: string;
  telegramSubjectCooldownSeconds: number;
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
  liveDeliveryAuthorized: boolean;
}

export interface RobinhoodPhase2Result {
  status: "disabled" | "source_unavailable" | "source_unhealthy" | "persisted";
  delivery: "shadow" | "telegram";
  draftsMaterialized: number;
  draftsStaled: number;
  readiness?: RobinhoodPhase2Readiness;
}

export interface RobinhoodPhase2TelegramDeliveryResult {
  status: "disabled" | "initialized" | "completed";
  sent: number;
  retryWait: number;
  unknown: number;
  suppressedCooldown: number;
  oversized: number;
}

type TelegramDeliverySendOutcome = "sent" | "failed" | "unknown";

interface TelegramDeliveryCandidate {
  alert_id: string;
  message: string;
  subject_key: string;
  delivery_state: string | null;
  attempts: number | null;
}

interface Phase1CandidateRow {
  pool_key: string;
  subject_type?: "pool" | "token";
  subject_address?: string;
  pool_address?: string | null;
  source_kind?: "rpc" | "gmgn";
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
  sourceKind?: "rpc" | "gmgn";
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
  const discoverySource = dotGet(config, "data_sources.robinhood_chain.phase1.discovery_source", "rpc");
  const enabled = raw.enabled === true;
  const delivery = String(raw.delivery ?? "shadow");
  if (enabled && delivery !== "shadow" && delivery !== "telegram") {
    throw new Error("Robinhood Chain Phase 2 delivery must be shadow or telegram");
  }
  return {
    enabled,
    delivery: delivery === "telegram" ? "telegram" : "shadow",
    fieldRunRevision: discoverySource === "gmgn" ? GMGN_FIELD_RUN_REVISION : fieldRunRevision(raw.field_run_revision),
    telegramSubjectCooldownSeconds: boundedInt(raw.telegram_subject_cooldown_seconds, 3_600, 300, 86_400),
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
  const subjectType = row.subject_type ?? "pool";
  const subjectAddress = row.subject_address ?? row.pool_key;
  return createHash("sha256")
    .update(`${subjectType}:${subjectAddress}:${row.window_start}:${row.config_revision}:${fieldRunRevision}`)
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
  const volume = Number(evidence.volumeUsd ?? evidence.volume5mUsd ?? 0);
  const traders = Number(evidence.uniqueTraders ?? 0);
  const subjectType = row.subject_type ?? "pool";
  const subjectAddress = row.subject_address ?? row.pool_key;
  const poolAddress = row.pool_address ?? (subjectType === "pool" ? row.pool_key : null);
  const sourceKind = row.source_kind ?? "rpc";
  const identity = poolAddress ? `token=${subjectAddress} pool=${poolAddress}` : `${subjectType}=${subjectAddress}`;
  const projectXHandle = normalizeGmgnProjectXHandle(evidence.projectXHandle);
  return [
    `Robinhood Chain shadow trend (${strength(row.score)})`,
    `source=${sourceKind} ${identity}`,
    `score=${row.score.toFixed(2)} volume_5m_usd=${volume.toFixed(2)} unique_traders=${traders}`,
    ...(projectXHandle ? [`project_x=@${projectXHandle} (GMGN-declared)`] : []),
    sourceKind === "rpc"
      ? `window_start=${row.window_start} blocks=${row.source_first_block}-${row.source_last_block}`
      : `window_start=${row.window_start}`,
    "Shadow evidence only; not a trading instruction.",
  ].join("\n");
}

function readPhase1Snapshot(path: string, now: number, cfg: RobinhoodPhase2Config): Phase1Snapshot {
  if (!sqliteDbExists(path)) {
    return {
      status: "unavailable",
      sourceKind: "rpc",
      lastSuccessAt: null,
      auditedWindows: 0,
      candidates: [],
      xPosts: new Map(),
    };
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
      return {
        status: "unhealthy",
        sourceKind: "rpc",
        lastSuccessAt,
        auditedWindows: 0,
        candidates: [],
        xPosts: new Map(),
      };
    }
    const since = now - cfg.lookbackHours * 3600;
    const auditColumns = db.prepare("PRAGMA table_info(signal_audit)").all() as Array<{ name?: string }>;
    const laneAware = auditColumns.some((row) => row.name === "collection_lane");
    if (!laneAware) {
      return {
        status: "unavailable",
        sourceKind: "rpc",
        lastSuccessAt,
        auditedWindows: 0,
        candidates: [],
        xPosts: new Map(),
      };
    }
    const auditRow = db
      .prepare("SELECT COUNT(*) AS count FROM signal_audit WHERE window_start>=? AND collection_lane='realtime'")
      .get(since) as { count?: number };
    const candidates = db
      .prepare(`
        SELECT tc.pool_key,'pool' AS subject_type,tc.pool_key AS subject_address,tc.pool_key AS pool_address,
               'rpc' AS source_kind,tc.window_start,tc.score,tc.components_json,tc.evidence_json,
               p.protocol_id,p.token0,p.token1,sa.source_first_block,sa.source_last_block,
               sa.decoder_version,sa.config_revision
        FROM trend_candidates tc
        JOIN pools p ON p.pool_key=tc.pool_key
        JOIN signal_audit sa ON sa.pool_key=tc.pool_key AND sa.window_start=tc.window_start
        WHERE tc.state='qualified' AND tc.window_start>=? AND sa.collection_lane='realtime'
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
      sourceKind: "rpc",
      lastSuccessAt,
      auditedWindows: Number(auditRow.count ?? 0),
      candidates,
      xPosts,
    };
  } catch {
    return {
      status: "unavailable",
      sourceKind: "rpc",
      lastSuccessAt: null,
      auditedWindows: 0,
      candidates: [],
      xPosts: new Map(),
    };
  } finally {
    db.close();
  }
}

function readXPosts(
  path: string,
  since: number,
  candidates: readonly Phase1CandidateRow[],
): Map<string, Array<{ id: string; handle: string; text: string; url: string; createdAt: string }>> {
  const xPosts = new Map<string, Array<{ id: string; handle: string; text: string; url: string; createdAt: string }>>();
  if (!sqliteDbExists(path)) return xPosts;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_posts'").get();
    if (!table) return xPosts;
    const query = db.prepare(`
      SELECT post_id,handle,text,url,created_at FROM account_posts
      WHERE fetched_at>=? AND (lower(text) LIKE ? OR lower(text) LIKE ?)
      ORDER BY fetched_at DESC LIMIT 3
    `);
    for (const candidate of candidates) {
      const subjectType = candidate.subject_type ?? "pool";
      const subjectAddress = candidate.subject_address ?? candidate.pool_key;
      const poolAddress = candidate.pool_address ?? (subjectType === "pool" ? candidate.pool_key : null);
      const rows = query.all(
        since,
        `%${subjectAddress.toLowerCase()}%`,
        `%${(poolAddress ?? subjectAddress).toLowerCase()}%`,
      ) as Array<Record<string, unknown>>;
      xPosts.set(
        `${subjectType}:${subjectAddress}:${candidate.window_start}`,
        rows.map((row) => ({
          id: String(row.post_id),
          handle: String(row.handle),
          text: String(row.text).slice(0, 1000),
          url: String(row.url).slice(0, 1000),
          createdAt: String(row.created_at).slice(0, 100),
        })),
      );
    }
    return xPosts;
  } catch {
    return new Map();
  } finally {
    db.close();
  }
}

function readGmgnSnapshot(path: string, xPath: string, now: number, cfg: RobinhoodPhase2Config): Phase1Snapshot {
  if (!sqliteDbExists(path)) {
    return {
      status: "unavailable",
      sourceKind: "gmgn",
      lastSuccessAt: null,
      auditedWindows: 0,
      candidates: [],
      xPosts: new Map(),
    };
  }
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const health = db
      .prepare("SELECT status,last_success_at,field_run_revision FROM source_health WHERE source='gmgn'")
      .get() as { status?: string; last_success_at?: number | null; field_run_revision?: string } | undefined;
    const lastSuccessAt = health?.last_success_at == null ? null : Number(health.last_success_at);
    if (
      health?.status !== "ok" ||
      health.field_run_revision !== GMGN_FIELD_RUN_REVISION ||
      lastSuccessAt == null ||
      !Number.isFinite(lastSuccessAt) ||
      lastSuccessAt > now + 60 ||
      now - lastSuccessAt > cfg.sourceMaxAgeSeconds
    ) {
      return {
        status: "unhealthy",
        sourceKind: "gmgn",
        lastSuccessAt,
        auditedWindows: 0,
        candidates: [],
        xPosts: new Map(),
      };
    }
    const since = now - cfg.lookbackHours * 3600;
    const candidates = db
      .prepare(`
        SELECT COALESCE(pool_address,subject_address) AS pool_key,subject_type,subject_address,pool_address,
               'gmgn' AS source_kind,window_start,score,'{}' AS components_json,evidence_json,
               'gmgn' AS protocol_id,subject_address AS token0,'' AS token1,0 AS source_first_block,
               0 AS source_last_block,'gmgn-v1' AS decoder_version,field_run_revision AS config_revision
        FROM gmgn_candidates
        WHERE state='qualified' AND verified=1 AND window_start>=? AND field_run_revision=?
        ORDER BY score DESC,window_start DESC LIMIT ?
      `)
      .all(since, GMGN_FIELD_RUN_REVISION, cfg.maxCandidatesPerRun) as unknown as Phase1CandidateRow[];
    const audit = db
      .prepare(`
        SELECT COUNT(*) AS count FROM gmgn_candidates
        WHERE state='qualified' AND verified=1 AND window_start>=? AND field_run_revision=?
      `)
      .get(since, GMGN_FIELD_RUN_REVISION) as { count?: number };
    return {
      status: "ok",
      sourceKind: "gmgn",
      lastSuccessAt,
      auditedWindows: Number(audit.count ?? 0),
      candidates,
      xPosts: readXPosts(xPath, since, candidates),
    };
  } catch {
    return {
      status: "unavailable",
      sourceKind: "gmgn",
      lastSuccessAt: null,
      auditedWindows: 0,
      candidates: [],
      xPosts: new Map(),
    };
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
        audit_count INTEGER NOT NULL,error_code TEXT,field_run_revision TEXT NOT NULL DEFAULT 'legacy',
        source_kind TEXT NOT NULL DEFAULT 'rpc'
      );
      CREATE INDEX IF NOT EXISTS phase2_runs_started_idx ON phase2_runs(started_at);
      CREATE TABLE IF NOT EXISTS shadow_alerts (
        alert_id TEXT PRIMARY KEY,pool_key TEXT NOT NULL,window_start INTEGER NOT NULL,protocol_id TEXT NOT NULL,
        token0 TEXT NOT NULL,token1 TEXT NOT NULL,score REAL NOT NULL,strength TEXT NOT NULL,state TEXT NOT NULL,
        message TEXT NOT NULL,evidence_json TEXT NOT NULL,first_materialized_at INTEGER NOT NULL,
        last_materialized_at INTEGER NOT NULL,field_run_revision TEXT NOT NULL DEFAULT 'legacy',
        subject_type TEXT NOT NULL DEFAULT 'pool',subject_address TEXT NOT NULL DEFAULT '',pool_address TEXT,
        source_kind TEXT NOT NULL DEFAULT 'rpc'
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
    this.ensureColumn("phase2_runs", "source_kind", "TEXT NOT NULL DEFAULT 'rpc'");
    this.ensureColumn("shadow_alerts", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("alert_reviews", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("readiness_checks", "field_run_revision", "TEXT NOT NULL DEFAULT 'legacy'");
    this.ensureColumn("shadow_alerts", "subject_type", "TEXT NOT NULL DEFAULT 'pool'");
    this.ensureColumn("shadow_alerts", "subject_address", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("shadow_alerts", "pool_address", "TEXT");
    this.ensureColumn("shadow_alerts", "source_kind", "TEXT NOT NULL DEFAULT 'rpc'");
    this.db.prepare("UPDATE shadow_alerts SET subject_address=pool_key WHERE subject_address='' ").run();
    this.db
      .prepare("UPDATE shadow_alerts SET pool_address=pool_key WHERE subject_type='pool' AND pool_address IS NULL")
      .run();
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
      this.db
        .prepare("UPDATE shadow_alerts SET state='stale' WHERE state='draft' AND field_run_revision=?")
        .run(cfg.fieldRunRevision);
      let materialized = 0;
      const currentIds = new Set<string>();
      if (snapshot.status === "ok") {
        const upsert = this.db.prepare(`
          INSERT INTO shadow_alerts (
            alert_id,pool_key,window_start,protocol_id,token0,token1,score,strength,state,message,evidence_json,
            first_materialized_at,last_materialized_at,field_run_revision,subject_type,subject_address,pool_address,
            source_kind
          ) VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)
          ON CONFLICT(alert_id) DO UPDATE SET score=excluded.score,strength=excluded.strength,state='draft',
          message=excluded.message,evidence_json=excluded.evidence_json,last_materialized_at=excluded.last_materialized_at,
          field_run_revision=excluded.field_run_revision,subject_type=excluded.subject_type,
          subject_address=excluded.subject_address,pool_address=excluded.pool_address,source_kind=excluded.source_kind
        `);
        for (const row of snapshot.candidates) {
          const subjectType = row.subject_type ?? "pool";
          const subjectAddress = row.subject_address ?? row.pool_key;
          const poolAddress = row.pool_address ?? (subjectType === "pool" ? row.pool_key : null);
          const sourceKind = row.source_kind ?? "rpc";
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
            matchedXPosts:
              snapshot.xPosts.get(`${subjectType}:${subjectAddress}:${row.window_start}`) ??
              snapshot.xPosts.get(`${row.pool_key}:${row.window_start}`) ??
              [],
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
            subjectType,
            subjectAddress,
            poolAddress,
            sourceKind,
          );
          materialized += 1;
        }
      }
      this.db
        .prepare(`
          INSERT INTO phase2_runs (
            started_at,status,phase1_status,phase1_last_success_at,candidate_count,audit_count,error_code,
            field_run_revision,source_kind
          ) VALUES (?,?,?,?,?,?,?,?,?)
        `)
        .run(
          now,
          snapshot.status === "ok" ? "ok" : "source_error",
          snapshot.status,
          snapshot.lastSuccessAt,
          snapshot.candidates.length,
          snapshot.auditedWindows,
          snapshot.status === "ok" ? null : `${snapshot.sourceKind ?? "rpc"}_${snapshot.status}`,
          cfg.fieldRunRevision,
          snapshot.sourceKind ?? "rpc",
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
      liveDeliveryAuthorized: cfg.delivery === "telegram",
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

function openTelegramDeliveryDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_delivery_metadata (
      field_run_revision TEXT PRIMARY KEY,
      enabled_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_deliveries (
      alert_id TEXT PRIMARY KEY,
      field_run_revision TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      state TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      next_attempt_at INTEGER,
      sent_at INTEGER,
      last_error_category TEXT
    );
    CREATE INDEX IF NOT EXISTS telegram_deliveries_revision_state_idx
    ON telegram_deliveries(field_run_revision,state,next_attempt_at,created_at);
    CREATE TABLE IF NOT EXISTS telegram_subject_cooldowns (
      subject_key TEXT PRIMARY KEY,
      last_delivered_at INTEGER NOT NULL,
      source_alert_id TEXT NOT NULL
    );
  `);
  return db;
}

function telegramSubjectKey(fieldRunRevision: string, subjectType: string, subjectAddress: string): string {
  return `${fieldRunRevision}:${subjectType}:${subjectAddress.toLowerCase()}`;
}

function emptyTelegramDeliveryResult(
  status: RobinhoodPhase2TelegramDeliveryResult["status"],
): RobinhoodPhase2TelegramDeliveryResult {
  return {
    status,
    sent: 0,
    retryWait: 0,
    unknown: 0,
    suppressedCooldown: 0,
    oversized: 0,
  };
}

function initializeTelegramDeliveryDb(
  db: DatabaseSync,
  cfg: RobinhoodPhase2Config,
  now: number,
): { initialized: boolean; suppressedExisting: number } {
  const existing = db
    .prepare("SELECT enabled_at FROM telegram_delivery_metadata WHERE field_run_revision=?")
    .get(cfg.fieldRunRevision);
  if (existing) return { initialized: false, suppressedExisting: 0 };

  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db
      .prepare("INSERT OR IGNORE INTO telegram_delivery_metadata (field_run_revision,enabled_at) VALUES (?,?)")
      .run(cfg.fieldRunRevision, now);
    if (Number(inserted.changes) === 0) {
      db.exec("COMMIT");
      return { initialized: false, suppressedExisting: 0 };
    }
    const drafts = db
      .prepare(`
        SELECT alert_id,subject_type,subject_address
        FROM shadow_alerts
        WHERE field_run_revision=? AND state='draft'
        ORDER BY first_materialized_at,alert_id
      `)
      .all(cfg.fieldRunRevision) as Array<{
      alert_id: string;
      subject_type: string;
      subject_address: string;
    }>;
    const suppress = db.prepare(`
      INSERT INTO telegram_deliveries (
        alert_id,field_run_revision,subject_key,state,attempts,created_at,updated_at,
        next_attempt_at,sent_at,last_error_category
      ) VALUES (?,?,?,'suppressed_existing',0,?,?,NULL,NULL,NULL)
    `);
    const seedCooldown = db.prepare(`
      INSERT INTO telegram_subject_cooldowns (subject_key,last_delivered_at,source_alert_id)
      VALUES (?,?,?)
      ON CONFLICT(subject_key) DO UPDATE SET
        last_delivered_at=MAX(last_delivered_at,excluded.last_delivered_at),
        source_alert_id=excluded.source_alert_id
    `);
    for (const draft of drafts) {
      const subjectKey = telegramSubjectKey(cfg.fieldRunRevision, draft.subject_type, draft.subject_address);
      suppress.run(draft.alert_id, cfg.fieldRunRevision, subjectKey, now, now);
      seedCooldown.run(subjectKey, now, draft.alert_id);
    }
    db.exec("COMMIT");
    return { initialized: true, suppressedExisting: drafts.length };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initializeRobinhoodPhase2TelegramDelivery(options: {
  config: TradeConfig;
  phase2DbPath?: string;
  now?: number;
}): { initialized: boolean; suppressedExisting: number } {
  const cfg = resolveRobinhoodPhase2Config(options.config);
  if (cfg.delivery !== "telegram") return { initialized: false, suppressedExisting: 0 };
  const db = openTelegramDeliveryDb(options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH);
  try {
    return initializeTelegramDeliveryDb(db, cfg, options.now ?? Math.floor(Date.now() / 1000));
  } finally {
    db.close();
  }
}

function normalizedTelegramSendResult(
  result: TelegramDeliverySendOutcome | TelegramSingleSendResult,
): TelegramSingleSendResult {
  return typeof result === "string" ? { outcome: result } : result;
}

function telegramRetryDelaySeconds(attempts: number): number {
  return Math.min(3_600, 60 * 2 ** Math.max(0, attempts - 1));
}

export async function deliverRobinhoodPhase2Telegram(options: {
  config: TradeConfig;
  phase2DbPath?: string;
  now?: number;
  signal?: AbortSignal;
  send?: (
    message: string,
    config: TradeConfig,
    signal?: AbortSignal,
  ) => Promise<TelegramDeliverySendOutcome | TelegramSingleSendResult>;
  afterSend?: () => void;
}): Promise<RobinhoodPhase2TelegramDeliveryResult> {
  const cfg = resolveRobinhoodPhase2Config(options.config);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const db = openTelegramDeliveryDb(options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH);
  try {
    if (cfg.delivery !== "telegram") return emptyTelegramDeliveryResult("disabled");
    const initialization = initializeTelegramDeliveryDb(db, cfg, now);
    if (initialization.initialized) return emptyTelegramDeliveryResult("initialized");

    const result = emptyTelegramDeliveryResult("completed");
    const recovered = db
      .prepare(`
        UPDATE telegram_deliveries
        SET state='unknown',updated_at=?,next_attempt_at=NULL,last_error_category='telegram_restart_ambiguous'
        WHERE field_run_revision=? AND state='sending'
      `)
      .run(now, cfg.fieldRunRevision);
    result.unknown += Number(recovered.changes);

    const metadata = db
      .prepare("SELECT enabled_at FROM telegram_delivery_metadata WHERE field_run_revision=?")
      .get(cfg.fieldRunRevision) as { enabled_at?: number } | undefined;
    if (metadata?.enabled_at == null) throw new Error("Robinhood Phase 2 Telegram enablement boundary is missing");
    const candidates = db
      .prepare(`
        SELECT a.alert_id,a.message,
               a.field_run_revision || ':' || a.subject_type || ':' || lower(a.subject_address) AS subject_key,
               d.state AS delivery_state,d.attempts
        FROM shadow_alerts a
        LEFT JOIN telegram_deliveries d ON d.alert_id=a.alert_id
        WHERE a.field_run_revision=? AND a.state='draft' AND a.source_kind='gmgn'
          AND a.first_materialized_at>?
          AND (d.alert_id IS NULL OR (d.state='retry_wait' AND d.next_attempt_at<=?))
        ORDER BY a.first_materialized_at,a.alert_id
        LIMIT 500
      `)
      .all(cfg.fieldRunRevision, Number(metadata.enabled_at), now) as unknown as TelegramDeliveryCandidate[];

    let networkAttempts = 0;
    const insertTerminal = db.prepare(`
      INSERT INTO telegram_deliveries (
        alert_id,field_run_revision,subject_key,state,attempts,created_at,updated_at,
        next_attempt_at,sent_at,last_error_category
      ) VALUES (?,?,?,?,0,?,?,NULL,NULL,?)
    `);
    for (const candidate of candidates) {
      if (options.signal?.aborted) break;
      const cooldown = db
        .prepare("SELECT last_delivered_at FROM telegram_subject_cooldowns WHERE subject_key=?")
        .get(candidate.subject_key) as { last_delivered_at?: number } | undefined;
      if (
        cooldown?.last_delivered_at != null &&
        now - Number(cooldown.last_delivered_at) < cfg.telegramSubjectCooldownSeconds
      ) {
        if (candidate.delivery_state === "retry_wait") {
          db.prepare(`
            UPDATE telegram_deliveries
            SET state='suppressed_cooldown',updated_at=?,next_attempt_at=NULL,last_error_category=NULL
            WHERE alert_id=? AND state='retry_wait'
          `).run(now, candidate.alert_id);
        } else {
          insertTerminal.run(
            candidate.alert_id,
            cfg.fieldRunRevision,
            candidate.subject_key,
            "suppressed_cooldown",
            now,
            now,
            null,
          );
        }
        result.suppressedCooldown += 1;
        continue;
      }
      if (candidate.message.length > TG_MAX_LEN) {
        if (candidate.delivery_state === "retry_wait") {
          db.prepare(`
            UPDATE telegram_deliveries
            SET state='oversized',updated_at=?,next_attempt_at=NULL,last_error_category='telegram_message_oversized'
            WHERE alert_id=? AND state='retry_wait'
          `).run(now, candidate.alert_id);
        } else {
          insertTerminal.run(
            candidate.alert_id,
            cfg.fieldRunRevision,
            candidate.subject_key,
            "oversized",
            now,
            now,
            "telegram_message_oversized",
          );
        }
        result.oversized += 1;
        continue;
      }
      if (networkAttempts >= 10) break;

      db.exec("BEGIN IMMEDIATE");
      let claimedAttempts = Number(candidate.attempts ?? 0) + 1;
      try {
        if (candidate.delivery_state === "retry_wait") {
          const claimed = db
            .prepare(`
            UPDATE telegram_deliveries
            SET state='sending',attempts=attempts+1,updated_at=?,next_attempt_at=NULL,last_error_category=NULL
            WHERE alert_id=? AND state='retry_wait' AND next_attempt_at<=?
          `)
            .run(now, candidate.alert_id, now);
          if (Number(claimed.changes) === 0) {
            db.exec("COMMIT");
            continue;
          }
        } else {
          db.prepare(`
            INSERT INTO telegram_deliveries (
              alert_id,field_run_revision,subject_key,state,attempts,created_at,updated_at,
              next_attempt_at,sent_at,last_error_category
            ) VALUES (?,?,?,'sending',1,?,?,NULL,NULL,NULL)
          `).run(candidate.alert_id, cfg.fieldRunRevision, candidate.subject_key, now, now);
          claimedAttempts = 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      networkAttempts += 1;
      let sendResult: TelegramSingleSendResult;
      try {
        const rawResult = options.send
          ? await options.send(candidate.message, options.config, options.signal)
          : await sendTelegramSingle(candidate.message, options.config, { signal: options.signal });
        sendResult = normalizedTelegramSendResult(rawResult);
      } catch {
        sendResult = { outcome: "unknown", errorCategory: "telegram_sender_threw_unknown" };
      }
      options.afterSend?.();

      if (sendResult.outcome === "sent") {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(`
            UPDATE telegram_deliveries
            SET state='sent',updated_at=?,next_attempt_at=NULL,sent_at=?,last_error_category=NULL
            WHERE alert_id=? AND state='sending'
          `).run(now, now, candidate.alert_id);
          db.prepare(`
            INSERT INTO telegram_subject_cooldowns (subject_key,last_delivered_at,source_alert_id)
            VALUES (?,?,?)
            ON CONFLICT(subject_key) DO UPDATE SET
              last_delivered_at=excluded.last_delivered_at,source_alert_id=excluded.source_alert_id
          `).run(candidate.subject_key, now, candidate.alert_id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        result.sent += 1;
      } else if (sendResult.outcome === "failed") {
        db.prepare(`
          UPDATE telegram_deliveries
          SET state='retry_wait',updated_at=?,next_attempt_at=?,last_error_category=?
          WHERE alert_id=? AND state='sending'
        `).run(
          now,
          now + telegramRetryDelaySeconds(claimedAttempts),
          sendResult.errorCategory ?? "telegram_send_failed",
          candidate.alert_id,
        );
        result.retryWait += 1;
      } else {
        db.prepare(`
          UPDATE telegram_deliveries
          SET state='unknown',updated_at=?,next_attempt_at=NULL,last_error_category=?
          WHERE alert_id=? AND state='sending'
        `).run(now, sendResult.errorCategory ?? "telegram_send_unknown", candidate.alert_id);
        result.unknown += 1;
      }
    }
    return result;
  } finally {
    db.close();
  }
}

export async function collectRobinhoodPhase2(options: {
  config: TradeConfig;
  phase1DbPath?: string;
  gmgnDbPath?: string;
  phase2DbPath?: string;
  force?: boolean;
  now?: number;
}): Promise<RobinhoodPhase2Result> {
  const cfg = resolveRobinhoodPhase2Config(options.config);
  if (!cfg.enabled && !options.force) {
    return { status: "disabled", delivery: cfg.delivery, draftsMaterialized: 0, draftsStaled: 0 };
  }
  const phase2DbPath = options.phase2DbPath ?? ROBINHOOD_CHAIN_PHASE2_DB_PATH;
  await mkdir(dirname(phase2DbPath), { recursive: true });
  const store = new RobinhoodPhase2Store(phase2DbPath);
  try {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const phase1DbPath = options.phase1DbPath ?? ROBINHOOD_CHAIN_PHASE1_DB_PATH;
    const discoverySource = dotGet(options.config, "data_sources.robinhood_chain.phase1.discovery_source", "rpc");
    const snapshot =
      discoverySource === "gmgn"
        ? readGmgnSnapshot(options.gmgnDbPath ?? ROBINHOOD_CHAIN_GMGN_DB_PATH, phase1DbPath, now, cfg)
        : readPhase1Snapshot(phase1DbPath, now, cfg);
    const result = store.materialize({ now, cfg, snapshot });
    return {
      status:
        snapshot.status === "ok"
          ? "persisted"
          : snapshot.status === "unhealthy"
            ? "source_unhealthy"
            : "source_unavailable",
      delivery: cfg.delivery,
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
