import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { SIGNAL_ALERT_LOG_PATH } from "../paths.js";
import { dotGet, loadTradeConfig } from "./config.js";
import { fetchMajorPrices, okxGet, runOnchainos } from "./data-helpers.js";
import { openSqliteDb } from "./sqlite-db.js";
import { getScratchpad, SIGNAL_WEIGHT_CATEGORIES } from "./scratchpad.js";

export const ACCURACY_DB_PATH = join(homedir(), ".onchainos", "strategies", "alerts", "rule_state.db");

const WINDOWS = { "2h": 2 * 3600, "6h": 6 * 3600, "24h": 24 * 3600 } as const;
const GRACE_SEC = 300;
const TRACK_SEVERITIES = new Set(["warning", "critical"]);
const MAJOR_ASSETS = new Set(["BTC", "ETH", "SOL"]);
const STOCK_TICKERS = new Set(["CRCL", "PDD", "GLD", "01810", "SH000001", "SZ399001", "VIX"]);
const CHAIN_MAP: Record<string, string> = {
  sol: "solana", eth: "ethereum", bsc: "bsc", base: "base",
  solana: "solana", ethereum: "ethereum"
};

const RULE_TO_CATEGORY: Record<string, string> = {
  "聪明钱": "smart_money",
  "大户转账": "smart_money",
  Polymarket: "event",
  "股票异动": "event",
  "VIX 飙升": "event",
  "期权异常": "event",
  PANews事件: "event",
  "宏观经济": "event",
  "Meme 大额": "meme",
  "Meme 新币": "meme",
  RSI超买: "technical",
  RSI超卖: "technical",
  "均线跌破": "technical",
  "均线突破": "technical",
  BBands突破: "technical"
};

export type AccuracyWindow = keyof typeof WINDOWS;

export interface RuleStats {
  rule: string;
  total: number;
  validated: number;
  hits: number;
  hit_rate: number | null;
  avg_pct: number | null;
  avg_strength: number | null;
}

export interface DriftEntry {
  rule: string;
  recent_rate: number;
  recent_n: number;
  baseline_rate: number;
  baseline_n: number;
  delta_pp: number;
}

function yahooSymbol(symbol: string): string {
  if (symbol.startsWith("SH") || symbol.startsWith("SZ")) {
    const code = symbol.slice(2);
    return symbol.startsWith("SH") ? `${code}.SS` : `${code}.SZ`;
  }
  if (/^\d+$/.test(symbol) && symbol.length >= 4) return `${Number.parseInt(symbol, 10)}.HK`;
  if (symbol.toUpperCase() === "VIX") return "^VIX";
  return symbol;
}

async function fetchHistoricalPrice(asset: string, targetTs: number): Promise<number | null> {
  const instMap: Record<string, string> = { BTC: "BTC-USDT", ETH: "ETH-USDT", SOL: "SOL-USDT" };
  const instId = instMap[asset.toUpperCase()];
  if (!instId) return null;
  const afterMs = String(Math.floor((targetTs + 3600) * 1000));
  const resp = await okxGet("/api/v5/market/candles", { instId, bar: "1H", limit: "3", after: afterMs });
  const candles = resp.data as string[][] | undefined;
  if (!candles?.length) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const c of candles) {
    const candleTs = Number(c[0]) / 1000;
    const close = Number.parseFloat(c[4] ?? "0");
    const dist = Math.abs(candleTs - targetTs);
    if (dist < bestDist && Number.isFinite(close)) {
      bestDist = dist;
      best = close;
    }
  }
  return best;
}

async function fetchStockHistoricalPrice(symbol: string, targetTs: number): Promise<number | null> {
  const yfSym = yahooSymbol(symbol);
  const p1 = Math.floor(targetTs - 3600);
  const p2 = Math.floor(targetTs + 7200);
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yfSym)}?period1=${p1}&period2=${p2}&interval=60m`,
      { headers: { "User-Agent": "Mozilla/5.0 king-ai/1.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> }; meta?: { regularMarketPrice?: number } }> };
    };
    const result = body.chart?.result?.[0];
    const timestamps = result?.timestamp ?? [];
    const closes = result?.indicators?.quote?.[0]?.close ?? [];
    let best: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      const close = closes[i];
      if (close == null) continue;
      const dist = Math.abs((timestamps[i] ?? 0) - targetTs);
      if (dist < bestDist) {
        bestDist = dist;
        best = close;
      }
    }
    if (best) return best;
    const meta = result?.meta?.regularMarketPrice ?? 0;
    return meta > 0 ? meta : null;
  } catch {
    return null;
  }
}

async function fetchTokenMcap(contract: string, chain: string): Promise<number | null> {
  const chainNorm = CHAIN_MAP[chain.toLowerCase()] ?? chain.toLowerCase();
  const data = await runOnchainos(["token", "search", "--query", contract, "--chain", chainNorm]) as {
    data?: Array<{ marketCap?: number }>;
  };
  const mcap = Number(data?.data?.[0]?.marketCap ?? 0);
  return mcap > 0 ? mcap : null;
}

export class AccuracyTracker {
  private readonly db = openSqliteDb(ACCURACY_DB_PATH);

  constructor() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alert_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_ts REAL NOT NULL,
        rule TEXT NOT NULL,
        severity TEXT NOT NULL,
        asset TEXT DEFAULT '',
        direction REAL DEFAULT 0,
        strength REAL DEFAULT 0,
        entry_prices TEXT,
        token_contract TEXT DEFAULT '',
        token_chain TEXT DEFAULT '',
        token_mcap REAL DEFAULT 0,
        token_entry_price REAL DEFAULT 0,
        regime_at_alert TEXT DEFAULT 'unknown',
        price_2h TEXT, pct_2h REAL, hit_2h INTEGER,
        price_6h TEXT, pct_6h REAL, hit_6h INTEGER,
        price_24h TEXT, pct_24h REAL, hit_24h INTEGER,
        UNIQUE(alert_ts, rule, asset)
      )
    `);
    for (const ddl of [
      "ALTER TABLE alert_outcomes ADD COLUMN token_entry_price REAL DEFAULT 0",
      "ALTER TABLE alert_outcomes ADD COLUMN regime_at_alert TEXT DEFAULT 'unknown'"
    ]) {
      try { this.db.exec(ddl); } catch { /* exists */ }
    }
  }

  async ingestAlerts(days = 30, jsonlPath = SIGNAL_ALERT_LOG_PATH): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(jsonlPath, "utf8");
    } catch {
      return 0;
    }
    const cutoff = Date.now() / 1000 - days * 86400;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO alert_outcomes
      (alert_ts, rule, severity, asset, direction, strength, entry_prices,
       token_contract, token_chain, token_mcap, regime_at_alert)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!TRACK_SEVERITIES.has(String(entry.severity ?? ""))) continue;
      if (!entry.prices) continue;
      const direction = Number(entry.direction ?? 0);
      if (!direction) continue;
      const ts = Date.parse(String(entry.timestamp ?? ""));
      if (!Number.isFinite(ts) || ts / 1000 < cutoff) continue;
      const result = insert.run(
        ts / 1000,
        String(entry.rule ?? ""),
        String(entry.severity ?? ""),
        String(entry.asset ?? ""),
        direction,
        Number(entry.strength ?? 0),
        JSON.stringify(entry.prices),
        String(entry.token_contract ?? ""),
        String(entry.token_chain ?? ""),
        Number(entry.token_mcap ?? 0),
        String(entry.regime ?? "unknown")
      );
      if (result.changes > 0) inserted += 1;
    }
    return inserted;
  }

  async validatePending(): Promise<{ checked: number; updated: number; token_updated: number }> {
    const currentPrices = await fetchMajorPrices();
    if (!Object.keys(currentPrices).length) {
      return { checked: 0, updated: 0, token_updated: 0 };
    }
    const now = Date.now() / 1000;
    const rows = this.db.prepare(`
      SELECT id, alert_ts, asset, direction, entry_prices, hit_2h, hit_6h, hit_24h,
             token_contract, token_chain, token_mcap, rule
      FROM alert_outcomes
      WHERE hit_2h IS NULL OR hit_6h IS NULL OR hit_24h IS NULL
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END
    `).all() as Array<Record<string, unknown>>;

    const tokenContracts = new Map<string, string>();
    for (const row of rows) {
      const contract = String(row.token_contract ?? "");
      const chain = String(row.token_chain ?? "");
      const mcap = Number(row.token_mcap ?? 0);
      if (contract && chain && mcap > 0) tokenContracts.set(contract, chain);
    }
    const tokenMcaps = new Map<string, number>();
    let fetched = 0;
    for (const [contract, chain] of tokenContracts) {
      if (fetched >= 100) break;
      const mcap = await fetchTokenMcap(contract, chain);
      if (mcap) tokenMcaps.set(contract, mcap);
      fetched += 1;
    }

    let checked = 0;
    let updated = 0;
    let tokenUpdated = 0;

    for (const row of rows) {
      checked += 1;
      const rowId = Number(row.id);
      const alertTs = Number(row.alert_ts);
      const asset = String(row.asset ?? "");
      const direction = Number(row.direction ?? 0);
      let entryPrices: Record<string, number>;
      try {
        entryPrices = JSON.parse(String(row.entry_prices ?? "{}")) as Record<string, number>;
      } catch {
        continue;
      }

      const tokenContract = String(row.token_contract ?? "");
      const tokenMcap = Number(row.token_mcap ?? 0);
      let entryPrice: number | null = null;
      let priceAsset = asset.toUpperCase();
      let isToken = false;
      let isStock = false;

      if (tokenContract && tokenMcap > 0) {
        const currentMcap = tokenMcaps.get(tokenContract);
        if (!currentMcap) continue;
        entryPrice = tokenMcap;
        isToken = true;
      } else if (STOCK_TICKERS.has(asset)) {
        entryPrice = await fetchStockHistoricalPrice(asset, alertTs);
        isStock = true;
        if (!entryPrice || entryPrice <= 0) continue;
      } else if (MAJOR_ASSETS.has(priceAsset)) {
        entryPrice = entryPrices[priceAsset];
      } else if (priceAsset === "CRYPTO") {
        priceAsset = "BTC";
        entryPrice = entryPrices.BTC;
      } else {
        continue;
      }

      const updates: Record<string, { price: string; pct: number; hit: number }> = {};
      const existing = {
        "2h": row.hit_2h,
        "6h": row.hit_6h,
        "24h": row.hit_24h
      };

      for (const [label, windowSec] of Object.entries(WINDOWS) as Array<[AccuracyWindow, number]>) {
        if (existing[label] != null) continue;
        if (now < alertTs + windowSec + GRACE_SEC) continue;

        let validationPrice = isToken ? (tokenMcaps.get(tokenContract) ?? 0) : currentPrices[priceAsset] ?? 0;
        if (isStock) {
          const hist = await fetchStockHistoricalPrice(asset, alertTs + windowSec);
          if (!hist || hist <= 0) continue;
          validationPrice = hist;
        } else if (!isToken) {
          const hist = await fetchHistoricalPrice(priceAsset, alertTs + windowSec);
          if (hist && hist > 0) validationPrice = hist;
        }
        if (!entryPrice || !validationPrice) continue;

        const pct = ((validationPrice - entryPrice) / entryPrice) * 100;
        const hit = direction > 0
          ? (validationPrice > entryPrice ? 1 : 0)
          : (validationPrice < entryPrice ? 1 : 0);
        const priceSnapshot = isToken
          ? JSON.stringify({ token: validationPrice })
          : JSON.stringify({ [priceAsset]: validationPrice });
        updates[label] = { price: priceSnapshot, pct: Math.round(pct * 10000) / 10000, hit };
      }

      if (Object.keys(updates).length) {
        const clauses: string[] = [];
        const params: Array<string | number> = [];
        for (const [label, vals] of Object.entries(updates)) {
          clauses.push(`price_${label} = ?`, `pct_${label} = ?`, `hit_${label} = ?`);
          params.push(vals.price, vals.pct, vals.hit);
        }
        params.push(rowId);
        this.db.prepare(`UPDATE alert_outcomes SET ${clauses.join(", ")} WHERE id = ?`).run(...params);
        updated += 1;
        if (isToken) tokenUpdated += 1;
      }
    }

    return { checked, updated, token_updated: tokenUpdated };
  }

  getRuleStats(days = 30, window: AccuracyWindow = "6h", holdoutDays = 0, regime?: string): RuleStats[] {
    const cutoff = Date.now() / 1000 - days * 86400;
    const holdoutCutoff = holdoutDays > 0 ? Date.now() / 1000 - holdoutDays * 86400 : Infinity;
    const hitCol = `hit_${window}`;
    const pctCol = `pct_${window}`;
    let sql = `
      SELECT rule, COUNT(*) as total, COUNT(${hitCol}) as validated,
             SUM(CASE WHEN ${hitCol} = 1 THEN 1 ELSE 0 END) as hits,
             AVG(CASE WHEN ${hitCol} IS NOT NULL THEN ${pctCol} END) as avg_pct,
             AVG(strength) as avg_strength
      FROM alert_outcomes
      WHERE alert_ts >= ? AND alert_ts <= ?
    `;
    const params: Array<string | number> = [cutoff, holdoutCutoff];
    if (regime) {
      sql += " AND regime_at_alert = ?";
      params.push(regime);
    }
    sql += ` GROUP BY rule ORDER BY COUNT(${hitCol}) DESC`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const validated = Number(r.validated ?? 0);
      const hits = Number(r.hits ?? 0);
      const hitRate = validated > 0 ? Math.round((hits / validated) * 1000) / 10 : null;
      return {
        rule: String(r.rule ?? ""),
        total: Number(r.total ?? 0),
        validated,
        hits,
        hit_rate: hitRate,
        avg_pct: r.avg_pct != null ? Math.round(Number(r.avg_pct) * 100) / 100 : null,
        avg_strength: r.avg_strength != null ? Math.round(Number(r.avg_strength) * 1000) / 1000 : null
      };
    });
  }

  detectDrift(window: AccuracyWindow = "6h"): DriftEntry[] {
    const recent = this.getRuleStats(7, window);
    const baseline = this.getRuleStats(30, window, 7);
    const baselineMap = new Map(baseline.map((s) => [s.rule, s]));
    const drifts: DriftEntry[] = [];
    for (const s of recent) {
      const nR = s.validated ?? 0;
      if (nR < 10 || s.hit_rate == null) continue;
      const b = baselineMap.get(s.rule);
      if (!b || (b.validated ?? 0) < 20 || b.hit_rate == null) continue;
      const delta = s.hit_rate - b.hit_rate;
      if (delta > -20) continue;
      const p = s.hit_rate / 100;
      const ciHalf = 1.96 * Math.sqrt(p * (1 - p) / nR) * 100;
      if (s.hit_rate + ciHalf >= b.hit_rate) continue;
      drifts.push({
        rule: s.rule,
        recent_rate: s.hit_rate,
        recent_n: nR,
        baseline_rate: b.hit_rate,
        baseline_n: b.validated ?? 0,
        delta_pp: Math.round(delta * 10) / 10
      });
    }
    return drifts.sort((a, b) => a.delta_pp - b.delta_pp);
  }

  formatStats(days = 30, window: AccuracyWindow = "6h", holdoutDays = 0): string {
    const stats = this.getRuleStats(days, window, holdoutDays);
    if (!stats.length) return "暂无验证数据";
    const lines = [`📊 Alert Accuracy (${window} window, ${days}d rolling)\n`];
    for (const s of stats) {
      if (!s.validated) continue;
      const rate = s.hit_rate != null ? `${s.hit_rate.toFixed(0)}%` : "—";
      lines.push(`  ${s.rule}: ${s.hits}/${s.validated} = ${rate}`);
    }
    const totalV = stats.reduce((a, s) => a + s.validated, 0);
    const totalH = stats.reduce((a, s) => a + s.hits, 0);
    const overall = totalV ? Math.round((totalH / totalV) * 1000) / 10 : 0;
    lines.push(`\n  Overall: ${totalH}/${totalV} = ${overall}%`);
    return lines.join("\n");
  }

  async updateSignalWeights(days = 14, window: AccuracyWindow = "6h"): Promise<Record<string, number>> {
    const config = await loadTradeConfig();
    const baseWeights = (dotGet(config, "signals.weights", {}) ?? {}) as Record<string, number>;
    const stats = this.getRuleStats(days, window, 7);
    const catHits = new Map<string, Array<[number, number]>>();
    for (const s of stats) {
      const cat = RULE_TO_CATEGORY[s.rule];
      if (!cat || !s.validated) continue;
      const list = catHits.get(cat) ?? [];
      list.push([s.hits, s.validated]);
      catHits.set(cat, list);
    }
    const pad = getScratchpad();
    const overrides: Record<string, number> = {};
    for (const [cat, pairs] of catHits) {
      const totalHits = pairs.reduce((a, [h]) => a + h, 0);
      const totalValidated = pairs.reduce((a, [, v]) => a + v, 0);
      if (totalValidated < 10) continue;
      const hitRate = totalHits / totalValidated;
      const baseW = baseWeights[cat] ?? 0.15;
      let newW: number | null = null;
      let reason = "";
      if (hitRate < 0.3) {
        newW = Math.round(baseW * 0.25 * 1000) / 1000;
        reason = `hit_rate=${Math.round(hitRate * 100)}% <30% (n=${totalValidated})`;
      } else if (hitRate < 0.4) {
        newW = Math.round(baseW * 0.5 * 1000) / 1000;
        reason = `hit_rate=${Math.round(hitRate * 100)}% <40% (n=${totalValidated})`;
      } else if (hitRate > 0.7) {
        newW = Math.round(baseW * 1.2 * 1000) / 1000;
        reason = `hit_rate=${Math.round(hitRate * 100)}% >70% (n=${totalValidated})`;
      }
      if (newW != null && SIGNAL_WEIGHT_CATEGORIES.includes(cat as typeof SIGNAL_WEIGHT_CATEGORIES[number])) {
        await pad.setSignalWeightOverride(cat, newW, reason);
        overrides[cat] = newW;
      }
    }
    return overrides;
  }
}