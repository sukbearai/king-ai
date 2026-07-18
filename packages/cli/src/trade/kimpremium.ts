import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendJsonl } from "../jsonl.js";
import { TRADE_KIMPREMIUM_SNAPSHOTS_PATH, TRADE_KIMPREMIUM_STATE_PATH } from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import type { AlertSeverity } from "./domain.js";

type JsonObject = Record<string, unknown>;

export interface KimpremiumThresholds {
  liqPctWarning: number;
  liqPctCritical: number;
  liqRWarning: number;
  liqRCritical: number;
  r2PctWarning: number;
  r2PctCritical: number;
  utilWarning: number;
  utilCritical: number;
  mgPctWarning: number;
  thermoDeltaWarning: number;
  thermoDeltaCritical: number;
  volatilityWarningPercentile: number;
  volatilityCriticalPercentile: number;
}

export interface KimpremiumConfig {
  baseUrl: string;
  pollSeconds: number;
  requestTimeoutMs: number;
  generatedWarningHours: number;
  generatedCriticalHours: number;
  thresholds: KimpremiumThresholds;
}

export interface KimpremiumMetrics {
  r2: number;
  r2Pct: number;
  liq5d: number;
  liqPct: number;
  liqR: number;
  mg: number;
  mgPct: number;
  util: number;
  fin: number;
  dep: number;
  thermo: number;
}

export interface KimpremiumSnapshot {
  asof: string;
  generated: string;
  etfAsof: string;
  collectedAt: string;
  sourceUrl: string;
  metrics: KimpremiumMetrics;
  delta1d: Partial<Record<keyof KimpremiumMetrics, number>>;
  volatilityPercentile: Partial<Record<keyof KimpremiumMetrics, number>>;
}

export interface KimpremiumRiskIssue {
  key: string;
  label: string;
  severity: AlertSeverity;
  reason: string;
}

export interface KimpremiumAssessment {
  severity: AlertSeverity | null;
  freshnessHours: number;
  issues: KimpremiumRiskIssue[];
}

export interface KimpremiumFileState {
  lastSnapshot?: KimpremiumSnapshot;
  lastCheckedAt?: string;
  lastAlertKey?: string;
  lastSourceAlertLevel?: "warning" | "critical";
  failureStreak: number;
}

const DEFAULT_THRESHOLDS: KimpremiumThresholds = {
  liqPctWarning: 95,
  liqPctCritical: 99,
  liqRWarning: 8,
  liqRCritical: 10,
  r2PctWarning: 90,
  r2PctCritical: 97,
  utilWarning: 80,
  utilCritical: 90,
  mgPctWarning: 95,
  thermoDeltaWarning: 5,
  thermoDeltaCritical: 10,
  volatilityWarningPercentile: 95,
  volatilityCriticalPercentile: 99,
};

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseKimpremiumConfig(config: TradeConfig): KimpremiumConfig {
  const raw = (dotGet(config, "kimpremium", {}) ?? {}) as JsonObject;
  const thresholds = (raw.thresholds ?? {}) as JsonObject;
  const baseUrl = String(raw.base_url ?? "https://www.kimpremium.com").replace(/\/+$/, "");
  return {
    baseUrl,
    pollSeconds: Math.max(1, finiteOr(raw.poll_seconds, 300)),
    requestTimeoutMs: Math.max(1000, finiteOr(raw.request_timeout_ms, 10_000)),
    generatedWarningHours: Math.max(1, finiteOr(raw.generated_warning_hours, 48)),
    generatedCriticalHours: Math.max(1, finiteOr(raw.generated_critical_hours, 72)),
    thresholds: {
      liqPctWarning: finiteOr(thresholds.liq_pct_warning, DEFAULT_THRESHOLDS.liqPctWarning),
      liqPctCritical: finiteOr(thresholds.liq_pct_critical, DEFAULT_THRESHOLDS.liqPctCritical),
      liqRWarning: finiteOr(thresholds.liq_r_warning, DEFAULT_THRESHOLDS.liqRWarning),
      liqRCritical: finiteOr(thresholds.liq_r_critical, DEFAULT_THRESHOLDS.liqRCritical),
      r2PctWarning: finiteOr(thresholds.r2_pct_warning, DEFAULT_THRESHOLDS.r2PctWarning),
      r2PctCritical: finiteOr(thresholds.r2_pct_critical, DEFAULT_THRESHOLDS.r2PctCritical),
      utilWarning: finiteOr(thresholds.util_warning, DEFAULT_THRESHOLDS.utilWarning),
      utilCritical: finiteOr(thresholds.util_critical, DEFAULT_THRESHOLDS.utilCritical),
      mgPctWarning: finiteOr(thresholds.mg_pct_warning, DEFAULT_THRESHOLDS.mgPctWarning),
      thermoDeltaWarning: finiteOr(thresholds.thermo_delta_warning, DEFAULT_THRESHOLDS.thermoDeltaWarning),
      thermoDeltaCritical: finiteOr(thresholds.thermo_delta_critical, DEFAULT_THRESHOLDS.thermoDeltaCritical),
      volatilityWarningPercentile: finiteOr(
        thresholds.volatility_warning_percentile,
        DEFAULT_THRESHOLDS.volatilityWarningPercentile,
      ),
      volatilityCriticalPercentile: finiteOr(
        thresholds.volatility_critical_percentile,
        DEFAULT_THRESHOLDS.volatilityCriticalPercentile,
      ),
    },
  };
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(obj: JsonObject, key: string, label: string): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function requiredNumber(obj: JsonObject, key: string, label: string): number {
  const value = Number(obj[key]);
  if (!Number.isFinite(value)) throw new Error(`${label}.${key} must be a finite number`);
  return value;
}

function requiredNumberArray(obj: JsonObject, key: string, label: string): number[] {
  const value = obj[key];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} must be an array`);
  return value.map((item) => {
    if (item == null) return Number.NaN;
    const parsed = Number(item);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  });
}

function requiredStringArray(obj: JsonObject, key: string, label: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) throw new Error(`${label}.${key} must be an array`);
  return value.map(String);
}

function valueAt(values: number[], index: number, label: string): number {
  const value = values[index];
  if (!Number.isFinite(value)) throw new Error(`${label}[${index}] must be a finite number`);
  return value!;
}

function previousDelta(values: number[], index: number): number | undefined {
  if (index < 1) return undefined;
  const current = values[index];
  const previous = values[index - 1];
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return undefined;
  return current! - previous!;
}

function changePercentile(values: number[], index: number, lookback = 252): number | undefined {
  const current = previousDelta(values, index);
  if (current == null) return undefined;
  const history: number[] = [];
  const start = Math.max(1, index - lookback);
  for (let i = start; i < index; i++) {
    const delta = previousDelta(values, i);
    if (delta != null) history.push(Math.abs(delta));
  }
  if (history.length < 20) return undefined;
  const rank = history.filter((value) => value <= Math.abs(current)).length / history.length;
  return Math.round(rank * 1000) / 10;
}

export function buildKimpremiumSnapshot(
  metaInput: unknown,
  seriesInput: unknown,
  etfInput: unknown,
  sourceUrl: string,
  now = new Date(),
): KimpremiumSnapshot {
  const meta = asObject(metaInput, "meta");
  const series = asObject(seriesInput, "series");
  const etf = asObject(etfInput, "etf");
  const kpi = asObject(meta.kpi, "meta.kpi");
  const etfKpi = asObject(etf.kpi, "etf.kpi");
  const asof = requiredString(meta, "asof", "meta");
  const generated = requiredString(meta, "generated", "meta");

  const dates = requiredStringArray(series, "d", "series");
  const seriesIndex = dates.lastIndexOf(asof);
  if (seriesIndex < 0) throw new Error(`series.d does not contain meta.asof ${asof}`);

  const r2Series = requiredNumberArray(series, "r2", "series");
  const liqRSeries = requiredNumberArray(series, "liqR", "series");
  const finSeries = requiredNumberArray(series, "fin", "series");
  const depSeries = requiredNumberArray(series, "dep", "series");
  const utilSeries = requiredNumberArray(series, "util", "series");

  const etfAsof = requiredString(etf, "asof", "etf");
  const etfDates = requiredStringArray(etf, "d", "etf");
  const etfIndex = etfDates.lastIndexOf(etfAsof);
  if (etfIndex < 0) throw new Error(`etf.d does not contain etf.asof ${etfAsof}`);
  const thermoSeries = requiredNumberArray(etf, "thermo", "etf");

  const metrics: KimpremiumMetrics = {
    r2: requiredNumber(kpi, "r2", "meta.kpi"),
    r2Pct: requiredNumber(kpi, "r2Pct", "meta.kpi"),
    liq5d: requiredNumber(kpi, "liq5d", "meta.kpi"),
    liqPct: requiredNumber(kpi, "liqPct", "meta.kpi"),
    liqR: valueAt(liqRSeries, seriesIndex, "series.liqR"),
    mg: requiredNumber(kpi, "mg", "meta.kpi"),
    mgPct: requiredNumber(kpi, "mgPct", "meta.kpi"),
    util: requiredNumber(kpi, "util", "meta.kpi"),
    fin: requiredNumber(kpi, "fin", "meta.kpi"),
    dep: requiredNumber(kpi, "dep", "meta.kpi"),
    thermo: requiredNumber(etfKpi, "thermo", "etf.kpi"),
  };

  return {
    asof,
    generated,
    etfAsof,
    collectedAt: now.toISOString(),
    sourceUrl,
    metrics,
    delta1d: {
      r2: previousDelta(r2Series, seriesIndex),
      liqR: previousDelta(liqRSeries, seriesIndex),
      fin: previousDelta(finSeries, seriesIndex),
      dep: previousDelta(depSeries, seriesIndex),
      util: previousDelta(utilSeries, seriesIndex),
      thermo: previousDelta(thermoSeries, etfIndex),
    },
    volatilityPercentile: {
      r2: changePercentile(r2Series, seriesIndex),
      liqR: changePercentile(liqRSeries, seriesIndex),
      fin: changePercentile(finSeries, seriesIndex),
      util: changePercentile(utilSeries, seriesIndex),
      thermo: changePercentile(thermoSeries, etfIndex),
    },
  };
}

function parseGeneratedAt(value: string): number {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second = "00"] = match;
  return Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`);
}

function severityRank(value: AlertSeverity): number {
  return value === "critical" ? 2 : value === "warning" ? 1 : 0;
}

function maxSeverity(issues: KimpremiumRiskIssue[]): AlertSeverity | null {
  if (!issues.length) return null;
  return issues.reduce<AlertSeverity>(
    (max, issue) => (severityRank(issue.severity) > severityRank(max) ? issue.severity : max),
    issues[0]!.severity,
  );
}

export function assessKimpremiumSnapshot(
  snapshot: KimpremiumSnapshot,
  config: KimpremiumConfig,
  now = new Date(),
): KimpremiumAssessment {
  const issues: KimpremiumRiskIssue[] = [];
  const t = config.thresholds;
  const freshnessHours = Math.max(0, (now.getTime() - parseGeneratedAt(snapshot.generated)) / 3_600_000);

  const addThreshold = (key: string, label: string, value: number, warning: number, critical: number, unit: string) => {
    const severity = value >= critical ? "critical" : value >= warning ? "warning" : null;
    if (!severity) return;
    const threshold = severity === "critical" ? critical : warning;
    issues.push({ key, label, severity, reason: `${label} ${value.toFixed(2)}${unit}，达到 ${threshold}${unit} 阈值` });
  };

  if (!Number.isFinite(freshnessHours)) {
    issues.push({ key: "freshness", label: "数据新鲜度", severity: "critical", reason: "generated 时间无法解析" });
  } else if (freshnessHours >= config.generatedCriticalHours) {
    issues.push({
      key: "freshness",
      label: "数据新鲜度",
      severity: "critical",
      reason: `数据已停滞 ${freshnessHours.toFixed(1)} 小时`,
    });
  } else if (freshnessHours >= config.generatedWarningHours) {
    issues.push({
      key: "freshness",
      label: "数据新鲜度",
      severity: "warning",
      reason: `数据已 ${freshnessHours.toFixed(1)} 小时未更新`,
    });
  }

  addThreshold("liqPct", "强平历史分位", snapshot.metrics.liqPct, t.liqPctWarning, t.liqPctCritical, "%");
  addThreshold("liqR", "强平/未偿融资比", snapshot.metrics.liqR, t.liqRWarning, t.liqRCritical, "%");
  addThreshold("r2Pct", "R2 历史分位", snapshot.metrics.r2Pct, t.r2PctWarning, t.r2PctCritical, "%");
  addThreshold("util", "信用额度使用率", snapshot.metrics.util, t.utilWarning, t.utilCritical, "%");

  if (snapshot.metrics.mgPct >= t.mgPctWarning) {
    issues.push({
      key: "mgPct",
      label: "市值/GDP 分位",
      severity: "warning",
      reason: `市值/GDP 位于 ${snapshot.metrics.mgPct.toFixed(1)}% 历史分位，仅说明估值昂贵`,
    });
  }

  const thermoDelta = snapshot.delta1d.thermo;
  if (thermoDelta != null && thermoDelta >= t.thermoDeltaWarning) {
    const severity = thermoDelta >= t.thermoDeltaCritical ? "critical" : "warning";
    issues.push({
      key: "thermo_delta",
      label: "杠杆温度日变化",
      severity,
      reason: `杠杆温度单日上升 ${thermoDelta.toFixed(2)} 个百分点`,
    });
  }

  for (const key of ["r2", "liqR", "fin", "util", "thermo"] as const) {
    const delta = snapshot.delta1d[key];
    const percentile = snapshot.volatilityPercentile[key];
    if (delta == null || delta <= 0 || percentile == null || percentile < t.volatilityWarningPercentile) continue;
    const severity = percentile >= t.volatilityCriticalPercentile ? "critical" : "warning";
    issues.push({
      key: `${key}_volatility`,
      label: `${key} 上升速度`,
      severity,
      reason: `${key} 单日上升 ${delta.toFixed(2)}，变化速度处于历史 ${percentile.toFixed(1)}% 分位`,
    });
  }

  if (snapshot.metrics.liqPct >= t.liqPctWarning && snapshot.metrics.liqR >= t.liqRWarning) {
    issues.push({
      key: "liquidation_confluence",
      label: "强平共振",
      severity: "critical",
      reason: "强平规模与强平占融资余额比例同时进入高风险区",
    });
  }
  if (snapshot.metrics.r2Pct >= t.r2PctWarning && snapshot.metrics.util >= t.utilWarning) {
    issues.push({
      key: "leverage_confluence",
      label: "杠杆拥挤共振",
      severity: "warning",
      reason: "融资拥挤与券商信用额度使用率同时偏高",
    });
  }

  return { severity: maxSeverity(issues), freshnessHours, issues };
}

const EMPTY_STATE: KimpremiumFileState = { failureStreak: 0 };

export class KimpremiumStateStore {
  constructor(
    private readonly statePath = TRADE_KIMPREMIUM_STATE_PATH,
    private readonly historyPath = TRADE_KIMPREMIUM_SNAPSHOTS_PATH,
  ) {}

  async load(): Promise<KimpremiumFileState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as KimpremiumFileState;
      return { ...EMPTY_STATE, ...parsed };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
        return { ...EMPTY_STATE };
      }
      throw err;
    }
  }

  async save(state: KimpremiumFileState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.statePath);
  }

  async appendSnapshot(snapshot: KimpremiumSnapshot): Promise<void> {
    await appendJsonl(this.historyPath, snapshot);
  }
}
