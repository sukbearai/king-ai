import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { TRADE_ALERT_LOG_PATH, TRADE_SIGNAL_OUTCOMES_PATH } from "../paths.js";
import { appendJsonl } from "../jsonl.js";
import { okxGet } from "./data-helpers.js";

/** One OKX 1H candle: [tsMs, open, high, low, close, ...]. */
export type OkxCandle = string[];

export interface AuditAlertRow {
  rule_id: string;
  rule?: string;
  severity: string;
  title: string;
  detail?: string;
  timestamp: string;
  direction: number;
  strength?: number;
  asset: string;
  [key: string]: unknown;
}

export interface SignalOutcomeRow {
  key: string;
  rule_id: string;
  asset: string;
  severity: string;
  direction: number;
  alert_ts: string;
  ret_4h: number | null;
  ret_24h: number | null;
  status: "priced" | "unpriced";
}

export interface RuleQualityMetrics {
  rule_id: string;
  alerts: number;
  pushed: number;
  priced_pct: number;
  hit_rate_4h: number | null;
  hit_rate_24h: number | null;
  avg_edge_4h: number | null;
  avg_edge_24h: number | null;
}

export type CandleFetcher = (asset: string) => Promise<OkxCandle[]>;

export interface SignalQualityOptions {
  days?: number;
  json?: boolean;
  refresh?: boolean;
  nowMs?: number;
  alertLogPath?: string;
  outcomesPath?: string;
  candleFetcher?: CandleFetcher;
  /** When set, write text/JSON here instead of stdout (tests). */
  writeOut?: (text: string) => void;
}

const HOUR_MS = 3_600_000;
const MAX_CANDLE_PAGES = 30;
const CANDLE_PAGE_LIMIT = 100;
const MATCH_FALLBACK_MS = 2 * HOUR_MS;
const OUTCOME_MIN_AGE_MS = 25 * HOUR_MS;

export function outcomeCacheKey(timestamp: string, ruleId: string, asset: string, title: string): string {
  return createHash("sha1").update(`${timestamp}|${ruleId}|${asset}|${title}`).digest("hex");
}

export function parseAuditJsonlLine(line: string): AuditAlertRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    if (!row || typeof row !== "object") return null;
    const timestamp = String(row.timestamp ?? "");
    const asset = String(row.asset ?? "").trim();
    const ruleId = String(row.rule_id ?? row.ruleId ?? "").trim();
    const title = String(row.title ?? "");
    if (!timestamp || !ruleId) return null;
    return {
      ...row,
      rule_id: ruleId,
      severity: String(row.severity ?? "info"),
      title,
      timestamp,
      direction: Number(row.direction ?? 0) || 0,
      asset,
    };
  } catch {
    return null;
  }
}

export function isEligibleAuditRow(row: AuditAlertRow, nowMs: number, days: number): boolean {
  if (!row.asset) return false;
  const ts = Date.parse(row.timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = nowMs - ts;
  if (age < OUTCOME_MIN_AGE_MS) return false;
  if (age > days * 86_400_000) return false;
  return true;
}

/**
 * Base/forward price = close of the 1H candle whose hour contains T.
 * Fallback: nearest candle open within 2h of T. Returns null if none match.
 */
export function priceAtTimestamp(candles: OkxCandle[], targetMs: number): number | null {
  if (!candles.length) return null;
  let containing: { close: number } | null = null;
  let nearest: { close: number; dist: number } | null = null;

  for (const c of candles) {
    const openMs = Number(c[0]);
    if (!Number.isFinite(openMs)) continue;
    const closePx = Number(c[4]);
    if (!Number.isFinite(closePx) || closePx <= 0) continue;
    if (targetMs >= openMs && targetMs < openMs + HOUR_MS) {
      containing = { close: closePx };
      break;
    }
    const dist = Math.abs(targetMs - openMs);
    if (dist <= MATCH_FALLBACK_MS && (!nearest || dist < nearest.dist)) {
      nearest = { close: closePx, dist };
    }
  }
  if (containing) return containing.close;
  if (nearest) return nearest.close;
  return null;
}

export function forwardReturnPct(base: number, fwd: number): number {
  return ((fwd - base) / base) * 100;
}

/** direction>0 hit iff ret>0; direction<0 hit iff ret<0; direction==0 excluded. */
export function directionalHit(direction: number, ret: number | null): boolean | null {
  if (ret == null || !Number.isFinite(ret)) return null;
  if (direction > 0) return ret > 0;
  if (direction < 0) return ret < 0;
  return null;
}

/** edge = sign(direction) * ret; direction==0 excluded. */
export function directionalEdge(direction: number, ret: number | null): number | null {
  if (ret == null || !Number.isFinite(ret)) return null;
  if (direction > 0) return ret;
  if (direction < 0) return -ret;
  return null;
}

export function aggregateQualityMetrics(rows: SignalOutcomeRow[]): RuleQualityMetrics[] {
  const byRule = new Map<string, SignalOutcomeRow[]>();
  for (const row of rows) {
    const list = byRule.get(row.rule_id) ?? [];
    list.push(row);
    byRule.set(row.rule_id, list);
  }

  const metrics: RuleQualityMetrics[] = [];
  const ruleIds = [...byRule.keys()].sort();
  for (const ruleId of ruleIds) {
    metrics.push(metricsForRows(ruleId, byRule.get(ruleId)!));
  }
  metrics.push(metricsForRows("TOTAL", rows));
  return metrics;
}

function metricsForRows(ruleId: string, rows: SignalOutcomeRow[]): RuleQualityMetrics {
  const alerts = rows.length;
  const pushed = rows.filter((r) => r.severity === "warning" || r.severity === "critical").length;
  const priced = rows.filter((r) => r.status === "priced");
  const pricedPct = alerts === 0 ? 0 : (priced.length / alerts) * 100;

  const hits4: boolean[] = [];
  const hits24: boolean[] = [];
  const edges4: number[] = [];
  const edges24: number[] = [];
  for (const r of priced) {
    const h4 = directionalHit(r.direction, r.ret_4h);
    const h24 = directionalHit(r.direction, r.ret_24h);
    if (h4 != null) hits4.push(h4);
    if (h24 != null) hits24.push(h24);
    const e4 = directionalEdge(r.direction, r.ret_4h);
    const e24 = directionalEdge(r.direction, r.ret_24h);
    if (e4 != null) edges4.push(e4);
    if (e24 != null) edges24.push(e24);
  }

  return {
    rule_id: ruleId,
    alerts,
    pushed,
    priced_pct: pricedPct,
    hit_rate_4h: hits4.length ? (hits4.filter(Boolean).length / hits4.length) * 100 : null,
    hit_rate_24h: hits24.length ? (hits24.filter(Boolean).length / hits24.length) * 100 : null,
    avg_edge_4h: edges4.length ? edges4.reduce((a, b) => a + b, 0) / edges4.length : null,
    avg_edge_24h: edges24.length ? edges24.reduce((a, b) => a + b, 0) / edges24.length : null,
  };
}

export function formatQualityTable(metrics: RuleQualityMetrics[]): string {
  const headers = ["rule_id", "alerts", "pushed", "priced%", "hit4h%", "hit24h%", "edge4h", "edge24h"];
  const rows = metrics.map((m) => [
    m.rule_id,
    String(m.alerts),
    String(m.pushed),
    fmtNum(m.priced_pct, 1),
    fmtOpt(m.hit_rate_4h, 1),
    fmtOpt(m.hit_rate_24h, 1),
    fmtOpt(m.avg_edge_4h, 2),
    fmtOpt(m.avg_edge_24h, 2),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function fmtNum(n: number, digits: number): string {
  return n.toFixed(digits);
}

function fmtOpt(n: number | null, digits: number): string {
  return n == null ? "—" : n.toFixed(digits);
}

async function loadOutcomeCache(path: string): Promise<Map<string, SignalOutcomeRow>> {
  const map = new Map<string, SignalOutcomeRow>();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return map;
    }
    throw err;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as SignalOutcomeRow;
      if (row?.key) map.set(row.key, row);
    } catch {
      // tolerate malformed cache lines
    }
  }
  return map;
}

async function readAuditRows(path: string): Promise<AuditAlertRow[]> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const rows: AuditAlertRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseAuditJsonlLine(line);
    if (row) rows.push(row);
  }
  return rows;
}

/** Fetch OKX 1H candles covering [minTs - 1h, maxTs + 25h], newest-first pages, max 30 pages. */
export async function fetchOkxCandlesForRange(
  asset: string,
  minAlertTsMs: number,
  maxAlertTsMs: number,
  get: typeof okxGet = okxGet,
): Promise<OkxCandle[]> {
  const needOldest = minAlertTsMs - HOUR_MS;
  const needNewest = maxAlertTsMs + 25 * HOUR_MS;
  const collected: OkxCandle[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_CANDLE_PAGES; page++) {
    const params: Record<string, string> = {
      instId: `${asset.toUpperCase()}-USDT`,
      bar: "1H",
      limit: String(CANDLE_PAGE_LIMIT),
    };
    if (after) params.after = after;
    const resp = await get("/api/v5/market/history-candles", params);
    // okxGet never rejects: transport failure yields {} (no code field), while an
    // unknown instrument yields {code:"51001",data:[]}. Throw on transport failure
    // so callers can retry next run instead of caching a false "unpriced".
    const code = String((resp as Record<string, unknown>).code ?? "");
    if (!code) throw new Error(`okx candle fetch failed for ${asset}`);
    const data = Array.isArray(resp.data) ? (resp.data as OkxCandle[]) : [];
    if (!data.length) break;
    collected.push(...data);
    const oldest = data[data.length - 1]!;
    const oldestTs = Number(oldest[0]);
    after = String(oldestTs);
    if (!Number.isFinite(oldestTs) || oldestTs <= needOldest) break;
    // also stop if we've covered newest (page always starts near now on first call)
    void needNewest;
  }
  return collected;
}

function computeOutcomeForRow(row: AuditAlertRow, candles: OkxCandle[] | null): SignalOutcomeRow {
  const key = outcomeCacheKey(row.timestamp, row.rule_id, row.asset, row.title);
  const base: SignalOutcomeRow = {
    key,
    rule_id: row.rule_id,
    asset: row.asset,
    severity: row.severity,
    direction: row.direction,
    alert_ts: row.timestamp,
    ret_4h: null,
    ret_24h: null,
    status: "unpriced",
  };
  if (!candles || !candles.length) return base;

  const t0 = Date.parse(row.timestamp);
  if (!Number.isFinite(t0)) return base;
  const basePx = priceAtTimestamp(candles, t0);
  const px4 = priceAtTimestamp(candles, t0 + 4 * HOUR_MS);
  const px24 = priceAtTimestamp(candles, t0 + 24 * HOUR_MS);
  if (basePx == null || px4 == null || px24 == null) return base;

  return {
    ...base,
    ret_4h: forwardReturnPct(basePx, px4),
    ret_24h: forwardReturnPct(basePx, px24),
    status: "priced",
  };
}

/**
 * Evaluate historical trade alerts against OKX 1H forward returns.
 * CLI entry: `king-ai trade signal-quality [--days N] [--json] [--refresh]`.
 */
export async function runSignalQuality(options: SignalQualityOptions = {}): Promise<RuleQualityMetrics[]> {
  const days = options.days != null && Number.isFinite(options.days) && options.days > 0 ? options.days : 30;
  const nowMs = options.nowMs ?? Date.now();
  const alertLogPath = options.alertLogPath ?? TRADE_ALERT_LOG_PATH;
  const outcomesPath = options.outcomesPath ?? TRADE_SIGNAL_OUTCOMES_PATH;
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(`${text}\n`));

  const auditRows = (await readAuditRows(alertLogPath)).filter((r) => isEligibleAuditRow(r, nowMs, days));

  const cache = options.refresh ? new Map<string, SignalOutcomeRow>() : await loadOutcomeCache(outcomesPath);
  if (options.refresh) {
    await mkdir(dirname(outcomesPath), { recursive: true });
    await writeFile(outcomesPath, "", "utf8");
  }

  const missing = auditRows.filter((r) => !cache.has(outcomeCacheKey(r.timestamp, r.rule_id, r.asset, r.title)));

  // Group missing by asset for candle fetch
  const byAsset = new Map<string, AuditAlertRow[]>();
  for (const row of missing) {
    const a = row.asset.toUpperCase();
    const list = byAsset.get(a) ?? [];
    list.push(row);
    byAsset.set(a, list);
  }

  const usingDefaultFetcher = options.candleFetcher == null;
  const candleFetcher: CandleFetcher =
    options.candleFetcher ??
    (async (asset: string) => {
      const rows = byAsset.get(asset.toUpperCase()) ?? [];
      if (!rows.length) return [];
      let minTs = Infinity;
      let maxTs = -Infinity;
      for (const r of rows) {
        const t = Date.parse(r.timestamp);
        if (!Number.isFinite(t)) continue;
        if (t < minTs) minTs = t;
        if (t > maxTs) maxTs = t;
      }
      if (!Number.isFinite(minTs)) return [];
      return fetchOkxCandlesForRange(asset, minTs, maxTs);
    });

  // Preload candles per asset. Unknown instrument → empty → cached unpriced;
  // fetcher throw (transport failure) → skip this run so the rows retry later.
  const candlesByAsset = new Map<string, OkxCandle[]>();
  const failedAssets = new Set<string>();
  let fetched = 0;
  for (const asset of byAsset.keys()) {
    try {
      const candles = await candleFetcher(asset);
      candlesByAsset.set(asset, candles);
      fetched += 1;
      if (usingDefaultFetcher) {
        process.stderr.write(
          `[signal-quality] ${fetched}/${byAsset.size} ${asset}: ${candles.length ? `${candles.length} candles` : "unpriced"}\n`,
        );
      }
    } catch {
      failedAssets.add(asset);
      fetched += 1;
      if (usingDefaultFetcher) {
        process.stderr.write(
          `[signal-quality] ${fetched}/${byAsset.size} ${asset}: fetch failed, will retry next run\n`,
        );
      }
    }
  }

  const newly: SignalOutcomeRow[] = [];
  for (const row of missing) {
    if (failedAssets.has(row.asset.toUpperCase())) continue;
    const candles = candlesByAsset.get(row.asset.toUpperCase()) ?? null;
    const emptyInstrument = candles != null && candles.length === 0;
    const outcome = computeOutcomeForRow(row, emptyInstrument ? null : candles);
    // Explicit unpriced when no candles returned for asset
    if (emptyInstrument) outcome.status = "unpriced";
    newly.push(outcome);
    cache.set(outcome.key, outcome);
  }

  for (const row of newly) {
    await appendJsonl(outcomesPath, row);
  }

  // Metrics over all eligible alerts: prefer cache (includes prior runs)
  const ordered: SignalOutcomeRow[] = [];
  const seen = new Set<string>();
  for (const row of auditRows) {
    const key = outcomeCacheKey(row.timestamp, row.rule_id, row.asset, row.title);
    const cached = cache.get(key);
    if (cached && !seen.has(key)) {
      ordered.push(cached);
      seen.add(key);
    }
  }

  const metrics = aggregateQualityMetrics(ordered);
  if (options.json) {
    writeOut(JSON.stringify({ days, metrics, outcomes: ordered }, null, 2));
  } else {
    writeOut(formatQualityTable(metrics));
  }
  return metrics;
}
