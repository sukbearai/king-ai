import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { TRADE_SCRATCHPAD_PATH } from "../paths.js";
import { calcRsi, fetchOkxCandles } from "./market-indicators.js";

export type MarketRegime = "risk_on" | "risk_off" | "neutral" | "volatile";

export interface ScratchEntry {
  key: string;
  data: Record<string, unknown>;
  source: string;
  createdAt: number;
  expiresAt: number;
  tags: string[];
}

interface ScratchFile {
  entries: Record<string, Omit<ScratchEntry, "key">>;
  updatedAt: string;
}

const writeChains = new Map<string, Promise<unknown>>();

function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  writeChains.set(
    path,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export class Scratchpad {
  private entries = new Map<string, ScratchEntry>();

  constructor(private readonly path = TRADE_SCRATCHPAD_PATH) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as ScratchFile;
      const now = Date.now() / 1000;
      this.entries.clear();
      for (const [key, entry] of Object.entries(raw.entries ?? {})) {
        if (entry.expiresAt > 0 && now >= entry.expiresAt) continue;
        this.entries.set(key, { key, ...entry });
      }
    } catch {
      this.entries.clear();
    }
  }

  private async save(): Promise<void> {
    await withLock(this.path, async () => {
      const now = Date.now() / 1000;
      const entries: ScratchFile["entries"] = {};
      for (const [key, e] of this.entries) {
        if (e.expiresAt > 0 && now >= e.expiresAt) continue;
        entries[key] = {
          data: e.data,
          source: e.source,
          createdAt: e.createdAt,
          expiresAt: e.expiresAt,
          tags: e.tags,
        };
      }
      const body: ScratchFile = {
        entries,
        updatedAt: new Date().toISOString(),
      };
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      await rename(tmp, this.path);
    });
  }

  async write(
    key: string,
    data: Record<string, unknown>,
    options: { source?: string; ttlHours?: number; tags?: string[] } = {},
  ): Promise<void> {
    await this.load();
    const now = Date.now() / 1000;
    const ttlHours = options.ttlHours ?? 12;
    this.entries.set(key, {
      key,
      data,
      source: options.source ?? "",
      createdAt: now,
      expiresAt: ttlHours > 0 ? now + ttlHours * 3600 : 0,
      tags: options.tags ?? [],
    });
    await this.save();
  }

  async read(key: string): Promise<Record<string, unknown> | null> {
    await this.load();
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = Date.now() / 1000;
    if (entry.expiresAt > 0 && now >= entry.expiresAt) return null;
    return entry.data;
  }

  async has(key: string): Promise<boolean> {
    return (await this.read(key)) != null;
  }

  async setRegime(regime: MarketRegime, reason = "", source = ""): Promise<void> {
    await this.write("market_regime", { regime, reason }, { source, ttlHours: 24, tags: ["regime"] });
  }

  async getRegime(): Promise<MarketRegime> {
    const data = await this.read("market_regime");
    const regime = data?.regime;
    if (regime === "risk_on" || regime === "risk_off" || regime === "neutral" || regime === "volatile") {
      return regime;
    }
    return "neutral";
  }

  async autoDetectRegime(): Promise<MarketRegime | null> {
    try {
      const tickerRes = await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT", {
        headers: { "User-Agent": "king-ai/1.0" },
        signal: AbortSignal.timeout(5000),
      });
      if (!tickerRes.ok) return null;
      const tickerBody = (await tickerRes.json()) as { data?: Array<{ last?: string }> };
      const price = Number.parseFloat(tickerBody.data?.[0]?.last ?? "0");
      if (!Number.isFinite(price) || price <= 0) return null;

      const candles = await fetchOkxCandles("BTC-USDT", "1D", 200);
      if (candles.length < 200) return null;

      const closes = candles.map((c) => Number.parseFloat(c[4] ?? "0")).filter(Number.isFinite);
      const highs = candles.map((c) => Number.parseFloat(c[2] ?? "0")).filter(Number.isFinite);
      const lows = candles.map((c) => Number.parseFloat(c[3] ?? "0")).filter(Number.isFinite);
      if (closes.length < 200) return null;

      const ma200 = closes.reduce((a, b) => a + b, 0) / closes.length;

      let atrPct = 0;
      const period = 14;
      if (highs.length >= period + 1) {
        const trueRanges: number[] = [];
        for (let i = 1; i < highs.length; i++) {
          trueRanges.push(
            Math.max(highs[i]! - lows[i]!, Math.abs(highs[i]! - closes[i - 1]!), Math.abs(lows[i]! - closes[i - 1]!)),
          );
        }
        let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
        for (const tr of trueRanges.slice(period)) {
          atr = (atr * (period - 1) + tr) / period;
        }
        atrPct = (atr / price) * 100;
      }

      let rsiVal = 50;
      const rsiCandles = await fetchOkxCandles("BTC-USDT", "4H", 100);
      if (rsiCandles.length >= 15) {
        const rsiCloses = [...rsiCandles]
          .reverse()
          .map((c) => Number.parseFloat(c[4] ?? "0"))
          .filter(Number.isFinite);
        if (rsiCloses.length >= 15) rsiVal = calcRsi(rsiCloses);
      }

      const reasonParts: string[] = [];
      let baseRegime: MarketRegime;
      if (price > ma200 * 1.05) {
        baseRegime = "risk_on";
        reasonParts.push(
          `BTC $${price.toLocaleString()} > MA200 $${ma200.toLocaleString()} (+${((price / ma200 - 1) * 100).toFixed(1)}%)`,
        );
      } else if (price < ma200 * 0.95) {
        baseRegime = "risk_off";
        reasonParts.push(
          `BTC $${price.toLocaleString()} < MA200 $${ma200.toLocaleString()} (${((price / ma200 - 1) * 100).toFixed(1)}%)`,
        );
      } else {
        baseRegime = "neutral";
        reasonParts.push(
          `BTC $${price.toLocaleString()} ≈ MA200 $${ma200.toLocaleString()} (${((price / ma200 - 1) * 100).toFixed(1)}%)`,
        );
      }

      reasonParts.push(`RSI(4H)=${rsiVal.toFixed(0)}`, `ATR=${atrPct.toFixed(1)}%`);

      let regime: MarketRegime = baseRegime;
      if (baseRegime === "risk_on" && (rsiVal > 80 || atrPct > 4)) {
        regime = "volatile";
        if (rsiVal > 80) reasonParts.push("RSI过热→volatile");
        if (atrPct > 4) reasonParts.push("ATR高波→volatile");
      }

      await this.setRegime(regime, reasonParts.join(" | "), "auto_detect");
      const volLevel = atrPct > 4 ? "high" : atrPct > 2 ? "normal" : "low";
      await this.write(
        "market_volatility",
        {
          atr_pct: Math.round(atrPct * 100) / 100,
          level: volLevel,
          rsi_4h: Math.round(rsiVal * 10) / 10,
        },
        { source: "auto_detect", ttlHours: 6, tags: ["volatility"] },
      );

      return regime;
    } catch {
      return null;
    }
  }
}

let singleton: Scratchpad | null = null;

export function getScratchpad(): Scratchpad {
  if (!singleton) singleton = new Scratchpad();
  return singleton;
}
