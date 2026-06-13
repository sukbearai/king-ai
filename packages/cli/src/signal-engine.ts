/**
 * Multi-source signal fusion engine (ported from trade-agent SignalEngine).
 *
 * Aggregates configurable signal sources with weighted composite scoring:
 *   A. Smart Money (30%) — JSONL alerts from on-chain rules
 *   B. Technical (25%)   — RSI, MA momentum from OKX candles
 *   C. Social (20%)      — JSONL social-category alerts
 *   D. Event (15%)       — Polymarket, macro, stocks, etc.
 *   E. Meme/Alpha (10%)  — meme large buys / new tokens
 *
 * Composite score = Σ(direction × confidence × weight)
 */

import { readFile } from "node:fs/promises";
import { SIGNAL_ALERT_LOG_PATH } from "./paths.js";
import { loadSignalWeightOverrides } from "./trade/scratchpad.js";

// ── Types ─────────────────────────────────────────────────

export type SignalDirection = "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
export type SignalCategory = "smart_money" | "technical" | "social" | "event" | "meme";

export interface SignalResult {
  source: string;
  direction: number;
  confidence: number;
  detail: string;
  tokens: string[];
  tags: string[];
}

export interface TokenSignal {
  token: string;
  symbol: string;
  score: number;
  direction: SignalDirection;
  sources: SignalResult[];
  timestamp: string;
}

export interface ScanResult {
  signals: TokenSignal[];
  timestamp: string;
  summary: string;
}

export interface SignalSource {
  readonly name: string;
  readonly weight: number;
  evaluate(): Promise<SignalResult[]> | SignalResult[];
}

export interface SignalEngineOptions {
  sources?: SignalSource[];
  /** Optional per-category weight overrides (e.g. from accuracy tracker). */
  weightOverrides?: Partial<Record<SignalCategory, number>>;
  alertLogPath?: string;
}

export interface AlertLogEntry {
  rule?: string;
  severity?: string;
  title?: string;
  detail?: string;
  timestamp?: string;
  direction?: number;
  strength?: number;
  asset?: string;
  token_contract?: string;
  token_chain?: string;
  token_mcap?: number;
  _tsUnix?: number;
}

// ── Paths & constants ─────────────────────────────────────

export const DEFAULT_ALERT_LOG_PATH = SIGNAL_ALERT_LOG_PATH;

export const RULE_CATEGORY: Record<string, SignalCategory> = {
  "聪明钱": "smart_money",
  "大户转账": "smart_money",
  Polymarket: "event",
  "股票异动": "event",
  "VIX 飙升": "event",
  "期权异常": "event",
  "PANews事件": "event",
  宏观经济: "event",
  "Meme 大额": "meme",
  "Meme 新币": "meme"
};

const SOURCE_CATEGORY: Record<string, SignalCategory> = {
  "链上聪明钱": "smart_money",
  技术面: "technical",
  社交情绪: "social",
  事件驱动: "event",
  "Meme/Alpha": "meme"
};

const DIRECTION_ICONS: Record<SignalDirection, string> = {
  strong_buy: "🟢🟢",
  buy: "🟢",
  neutral: "⚪",
  sell: "🔴",
  strong_sell: "🔴🔴"
};

// ── Display time (UTC+8) ──────────────────────────────────

function formatDisplayTime(date = new Date()): string {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = utc8.getUTCFullYear();
  const m = String(utc8.getUTCMonth() + 1).padStart(2, "0");
  const d = String(utc8.getUTCDate()).padStart(2, "0");
  const h = String(utc8.getUTCHours()).padStart(2, "0");
  const min = String(utc8.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min} UTC+8`;
}

// ── OKX candles ───────────────────────────────────────────

type OkxCandle = [string, string, string, string, string, ...string[]];

export async function fetchOkxCandles(instId: string, bar = "1H", limit = 30): Promise<OkxCandle[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "king-ai/1.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: OkxCandle[] };
    return body.data ?? [];
  } catch {
    return [];
  }
}

// ── RSI ───────────────────────────────────────────────────

export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── Technical source ──────────────────────────────────────

export class TechnicalSource implements SignalSource {
  static readonly INSTRUMENTS = ["BTC-USDT", "ETH-USDT", "SOL-USDT"];

  readonly name = "技术面";
  readonly weight = 0.25;

  constructor(private readonly fetchCandles = fetchOkxCandles) {}

  async evaluate(): Promise<SignalResult[]> {
    const results: SignalResult[] = [];

    for (const inst of TechnicalSource.INSTRUMENTS) {
      const symbol = inst.split("-")[0]!;
      let direction = 0;
      let confidence = 0;
      const details: string[] = [];

      const candles = await this.fetchCandles(inst, "1H", 30);
      if (!candles.length || candles.length < 14) continue;

      const closes: number[] = [];
      for (const c of [...candles].reverse()) {
        const close = Number.parseFloat(c[4] ?? "");
        if (Number.isFinite(close)) closes.push(close);
      }

      if (closes.length >= 15) {
        const rsiVal = calcRsi(closes.slice(-15));
        if (rsiVal < 30) {
          direction += 0.5;
          details.push(`RSI=${rsiVal.toFixed(0)} 超卖`);
        } else if (rsiVal > 70) {
          direction -= 0.5;
          details.push(`RSI=${rsiVal.toFixed(0)} 超买`);
        } else {
          details.push(`RSI=${rsiVal.toFixed(0)}`);
        }
        confidence += 0.4;
      }

      if (closes.length >= 24) {
        const ma6 = closes.slice(-6).reduce((a, b) => a + b, 0) / 6;
        const ma24 = closes.slice(-24).reduce((a, b) => a + b, 0) / 24;
        if (ma24 > 0) {
          const momentum = (ma6 - ma24) / ma24;
          if (momentum > 0.03) {
            direction += 0.3;
            details.push(`动量 ${(momentum * 100).toFixed(1)}%`);
          } else if (momentum < -0.03) {
            direction -= 0.3;
            details.push(`动量 ${(momentum * 100).toFixed(1)}%`);
          }
          confidence += 0.3;
        }
      }

      direction = Math.max(-1, Math.min(1, direction));
      confidence = Math.min(confidence, 1);

      if (direction !== 0 || details.length) {
        results.push({
          source: this.name,
          direction,
          confidence,
          detail: details.length ? `${symbol}: ${details.join(", ")}` : `${symbol}: 数据不足`,
          tokens: [symbol],
          tags: []
        });
      }
    }

    return results;
  }
}

// ── Alert log source ──────────────────────────────────────

export async function readRecentJsonl(alertLogPath: string, hours = 6): Promise<AlertLogEntry[]> {
  let text: string;
  try {
    text = await readFile(alertLogPath, "utf8");
  } catch {
    return [];
  }

  const cutoff = Date.now() / 1000 - hours * 3600;
  const alerts: AlertLogEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: AlertLogEntry;
    try {
      entry = JSON.parse(trimmed) as AlertLogEntry;
    } catch {
      continue;
    }
    if (entry.severity !== "warning" && entry.severity !== "critical") continue;
    if (!entry.direction) continue;

    const tsStr = entry.timestamp ?? "";
    try {
      const ts = new Date(tsStr);
      if (Number.isNaN(ts.getTime())) continue;
      const tsUnix = ts.getTime() / 1000;
      if (tsUnix < cutoff) continue;
      entry._tsUnix = tsUnix;
    } catch {
      continue;
    }
    alerts.push(entry);
  }

  return alerts;
}

export class AlertLogSource implements SignalSource {
  constructor(
    private readonly category: SignalCategory,
    private readonly sourceName: string,
    private readonly sourceWeight: number,
    private readonly hours = 6,
    private readonly alertLogPath = DEFAULT_ALERT_LOG_PATH
  ) {}

  get name(): string {
    return this.sourceName;
  }

  get weight(): number {
    return this.sourceWeight;
  }

  async evaluate(): Promise<SignalResult[]> {
    const alerts = await readRecentJsonl(this.alertLogPath, this.hours);
    const results: SignalResult[] = [];
    const now = Date.now() / 1000;

    for (const entry of alerts) {
      const rule = entry.rule ?? "";
      if (RULE_CATEGORY[rule] !== this.category) continue;

      const direction = Math.max(-1, Math.min(1, Number(entry.direction) || 0));
      const strength = Number(entry.strength) || 0.5;
      const asset = entry.asset ?? "";

      const ageHours = (now - (entry._tsUnix ?? now)) / 3600;
      const decay = 0.5 ** (ageHours / 2);
      let confidence = Math.min(strength * decay, 1);

      if (entry.severity === "critical") {
        confidence = Math.max(confidence, 0.7);
      }

      const detailParts: string[] = [];
      if (asset) detailParts.push(asset);
      detailParts.push(rule);
      const title = entry.title ?? "";
      if (title) detailParts.push(title.slice(0, 40));

      const tokens: string[] = [];
      if (asset) tokens.push(asset);
      const tokenContract = entry.token_contract ?? "";
      if (tokenContract) tokens.push(tokenContract);

      results.push({
        source: this.name,
        direction,
        confidence,
        detail: detailParts.join(" — "),
        tokens: tokens.length ? tokens : [rule],
        tags: []
      });
    }

    return results;
  }
}

// ── Default sources ───────────────────────────────────────

export type SourceFactory = (alertLogPath: string) => SignalSource;

export const SOURCE_FACTORIES: Record<Exclude<SignalCategory, "technical">, SourceFactory> = {
  smart_money: (path) => new AlertLogSource("smart_money", "链上聪明钱", 0.3, 6, path),
  social: (path) => new AlertLogSource("social", "社交情绪", 0.2, 6, path),
  event: (path) => new AlertLogSource("event", "事件驱动", 0.15, 6, path),
  meme: (path) => new AlertLogSource("meme", "Meme/Alpha", 0.1, 6, path)
};

export function defaultSignalSources(alertLogPath = DEFAULT_ALERT_LOG_PATH): SignalSource[] {
  return [
    SOURCE_FACTORIES.smart_money(alertLogPath),
    new TechnicalSource(),
    SOURCE_FACTORIES.social(alertLogPath),
    SOURCE_FACTORIES.event(alertLogPath),
    SOURCE_FACTORIES.meme(alertLogPath)
  ];
}

export function buildSignalSources(
  sourceIds: SignalCategory[],
  alertLogPath = DEFAULT_ALERT_LOG_PATH
): SignalSource[] {
  const sources: SignalSource[] = [];
  for (const id of sourceIds) {
    if (id === "technical") {
      sources.push(new TechnicalSource());
    } else {
      const factory = SOURCE_FACTORIES[id];
      if (factory) sources.push(factory(alertLogPath));
    }
  }
  return sources;
}

// ── Signal engine ─────────────────────────────────────────

export class SignalEngine {
  private readonly sources: SignalSource[];
  private readonly weightOverrides: Partial<Record<SignalCategory, number>>;

  constructor(options: SignalEngineOptions = {}) {
    this.sources = options.sources ?? defaultSignalSources(options.alertLogPath);
    this.weightOverrides = options.weightOverrides ?? {};
  }

  private scratchpadOverrides: Partial<Record<SignalCategory, number>> = {};

  private effectiveWeight(source: SignalSource): number {
    const cat = SOURCE_CATEGORY[source.name];
    if (cat && this.weightOverrides[cat] != null) {
      return this.weightOverrides[cat]!;
    }
    if (cat && this.scratchpadOverrides[cat] != null) {
      return this.scratchpadOverrides[cat]!;
    }
    return source.weight;
  }

  async scan(): Promise<ScanResult> {
    if (!Object.keys(this.weightOverrides).length) {
      const loaded = await loadSignalWeightOverrides();
      this.scratchpadOverrides = loaded as Partial<Record<SignalCategory, number>>;
    }

    const allSignals: SignalResult[] = [];
    const sourceSummaries: string[] = [];

    for (const source of this.sources) {
      try {
        const signals = await source.evaluate();
        allSignals.push(...signals);
        if (signals.length) {
          const avgDir = signals.reduce((sum, s) => sum + s.direction, 0) / signals.length;
          const arrow = avgDir > 0.1 ? "↑" : avgDir < -0.1 ? "↓" : "→";
          sourceSummaries.push(`${source.name} ${arrow}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sourceSummaries.push(`${source.name} ❌ ${msg}`);
      }
    }

    const tokenSignals = new Map<string, Array<{ sig: SignalResult; weight: number }>>();
    const marketWide: Array<{ sig: SignalResult; weight: number }> = [];

    for (const sig of allSignals) {
      let effWeight = 0.2;
      for (const source of this.sources) {
        if (source.name === sig.source) {
          effWeight = this.effectiveWeight(source);
          break;
        }
      }

      if (sig.tokens.length) {
        for (const token of sig.tokens) {
          const bucket = tokenSignals.get(token) ?? [];
          bucket.push({ sig, weight: effWeight });
          tokenSignals.set(token, bucket);
        }
      } else {
        marketWide.push({ sig, weight: effWeight });
      }
    }

    const tokenResults: TokenSignal[] = [];

    for (const [token, sigs] of tokenSignals) {
      let score = sigs.reduce((sum, { sig, weight }) => sum + sig.direction * sig.confidence * weight, 0);
      if (sigs.length && marketWide.length) {
        for (const { sig, weight } of marketWide) {
          score += sig.direction * sig.confidence * weight * 0.5;
        }
      }
      score = Math.round(score * 10000) / 10000;

      let symbol = token;
      for (const { sig } of sigs) {
        if (sig.tokens.length && sig.detail) {
          const parts = sig.detail.split(/\s+/);
          if (parts[0]) symbol = parts[0].replace(/:$/, "");
        }
      }

      tokenResults.push({
        token,
        symbol,
        score,
        direction: classifyScore(score),
        sources: sigs.map(({ sig }) => sig),
        timestamp: new Date().toISOString()
      });
    }

    if (marketWide.length >= 2) {
      const marketScore = marketWide.reduce((sum, { sig, weight }) => sum + sig.direction * sig.confidence * weight, 0);
      if (Math.abs(marketScore) > 0.05) {
        tokenResults.push({
          token: "MARKET",
          symbol: "市场整体",
          score: marketScore,
          direction: classifyScore(marketScore),
          sources: marketWide.map(({ sig }) => sig),
          timestamp: new Date().toISOString()
        });
      }
    }

    const significant = tokenResults
      .filter((t) => Math.abs(t.score) > 0.05)
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 20);

    return {
      signals: significant,
      timestamp: formatDisplayTime(),
      summary: sourceSummaries.join(" | ")
    };
  }
}

export function classifyScore(score: number): SignalDirection {
  if (score >= 0.6) return "strong_buy";
  if (score >= 0.3) return "buy";
  if (score <= -0.6) return "strong_sell";
  if (score <= -0.3) return "sell";
  return "neutral";
}

// ── Formatting ────────────────────────────────────────────

export function formatTokenSignal(sig: TokenSignal): string {
  const icon = DIRECTION_ICONS[sig.direction] ?? "⚪";
  const lines = [`${icon} ${sig.symbol} — 综合得分: ${sig.score >= 0 ? "+" : ""}${sig.score.toFixed(2)} (${sig.direction})`];
  for (const s of sig.sources) {
    const arrow = s.direction > 0 ? "↑" : s.direction < 0 ? "↓" : "→";
    lines.push(`  [${s.source}] ${arrow} ${s.direction >= 0 ? "+" : ""}${s.direction.toFixed(2)} (置信度 ${Math.round(s.confidence * 100)}%) ${s.detail}`);
  }
  return lines.join("\n");
}

export function formatScanResult(result: ScanResult): string {
  if (!result.signals.length) {
    return "📡 信号扫描完成 — 无显著信号";
  }
  const parts = [`📡 信号扫描 — ${result.timestamp}\n`];
  for (const sig of [...result.signals].sort((a, b) => b.score - a.score)) {
    parts.push(formatTokenSignal(sig));
    parts.push("");
  }
  if (result.summary) parts.push(`📋 ${result.summary}`);
  return parts.join("\n");
}