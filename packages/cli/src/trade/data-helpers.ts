import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { formatDisplayTime } from "./time-utils.js";

const execFileP = promisify(execFile);
const OKX_BASE = "https://www.okx.com";
const OKX_UA = "Mozilla/5.0 king-ai/1.0";

export function nowDisplay(): string {
  return formatDisplayTime(new Date(), "hm");
}

export async function okxGet(path: string, params?: Record<string, string>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${OKX_BASE}${path}${qs}`, {
        headers: { "User-Agent": OKX_UA },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) continue;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  }
  return {};
}

export async function okxPost(path: string, body: Record<string, unknown>, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${OKX_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": OKX_UA },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) continue;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    }
  }
  return {};
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
    CLICOLOR: "0",
    FORCE_COLOR: "0"
  };
}

async function runCli(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  const { stdout } = await execFileP(bin, args, {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: cliEnv()
  });
  return stdout;
}

function parseCliJson(stdout: string): unknown {
  const trimmed = stripAnsi(stdout).trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!);
      } catch {
        continue;
      }
    }
  }
  return {};
}

function extractSurfList(resp: unknown): unknown[] {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    const data = (resp as Record<string, unknown>).data;
    if (Array.isArray(data)) return data;
  }
  return [];
}

function extractSurfObject(resp: unknown): Record<string, unknown> {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    const obj = resp as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      return obj.data as Record<string, unknown>;
    }
    return obj;
  }
  return {};
}

export async function runOnchainos(args: string[], timeoutMs = 15_000): Promise<unknown> {
  try {
    const out = await runCli("onchainos", args, timeoutMs);
    return parseCliJson(out);
  } catch {
    return {};
  }
}

export async function runTg(args: string[], timeoutMs = 60_000): Promise<string> {
  try {
    return await runCli("tg", args, timeoutMs);
  } catch {
    return "";
  }
}

export async function runGmgn(args: string[], timeoutMs = 30_000): Promise<unknown> {
  try {
    const out = await runCli("gmgn-cli", args, timeoutMs);
    return parseCliJson(out);
  } catch {
    return {};
  }
}

export async function runOpencli(args: string[], timeoutMs = 90_000): Promise<unknown[]> {
  try {
    const out = await runCli("opencli", args, timeoutMs);
    const parsed = parseCliJson(out);
    return Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
  } catch {
    return [];
  }
}

export async function runSurf(args: string[], timeoutMs = 30_000): Promise<unknown> {
  try {
    const out = await runCli("surf", args, timeoutMs);
    return parseCliJson(out);
  } catch {
    return {};
  }
}

export async function yahooFinanceQuote(symbol: string): Promise<{ price: number; change_pct?: number }> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const res = await fetch(url, {
      headers: { "User-Agent": OKX_UA },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) return { price: 0 };
    const body = (await res.json()) as {
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> };
    };
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? 0;
    const prev = meta?.previousClose ?? 0;
    const change_pct = prev > 0 ? ((price - prev) / prev) * 100 : undefined;
    return { price, change_pct };
  } catch {
    return { price: 0 };
  }
}

function yahooQuoteSymbol(symbol: string): string {
  if (/^\d+$/.test(symbol) && symbol.length >= 4) {
    return `${Number.parseInt(symbol, 10)}.HK`;
  }
  if (symbol.toUpperCase() === "VIX") return "^VIX";
  if (symbol.length >= 8 && (symbol.startsWith("SH") || symbol.startsWith("SZ"))) {
    const code = symbol.slice(2);
    return symbol.startsWith("SH") ? `${code}.SS` : `${code}.SZ`;
  }
  return symbol;
}

export async function stockQuote(symbol: string): Promise<{ price: number; change_pct?: number; source?: string }> {
  const yf = await yahooFinanceQuote(yahooQuoteSymbol(symbol));
  if (yf.price > 0) return { ...yf, source: "yahoo" };
  return { price: 0 };
}

export async function fetchMajorPrices(): Promise<Record<string, number>> {
  const prices: Record<string, number> = {};
  for (const inst of ["BTC-USDT", "ETH-USDT", "SOL-USDT"]) {
    const resp = await okxGet("/api/v5/market/ticker", { instId: inst });
    const data = resp.data as Array<{ last?: string }> | undefined;
    const last = Number.parseFloat(data?.[0]?.last ?? "0");
    if (Number.isFinite(last) && last > 0) {
      prices[inst.split("-")[0]!] = last;
    }
  }
  return prices;
}

export async function blockbeatsGet(path: string, apiKey: string, params?: Record<string, string>): Promise<unknown> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  try {
    const res = await fetch(`https://api.theblockbeats.news${path}${qs}`, {
      headers: {
        "User-Agent": OKX_UA,
        Authorization: `Bearer ${apiKey}`
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

const GMGN_CHAIN_SLUG: Record<string, string> = {
  solana: "sol",
  sol: "sol",
  ethereum: "eth",
  eth: "eth",
  bsc: "bsc",
  base: "base",
  arbitrum: "arb",
  arb: "arb"
};

const TX_EXPLORER_BASE: Record<string, string> = {
  solana: "https://solscan.io/tx/",
  sol: "https://solscan.io/tx/",
  ethereum: "https://etherscan.io/tx/",
  eth: "https://etherscan.io/tx/",
  bsc: "https://bscscan.com/tx/",
  base: "https://basescan.org/tx/",
  arbitrum: "https://arbiscan.io/tx/",
  arb: "https://arbiscan.io/tx/"
};

export function gmgnTokenUrl(chain: string, address: string): string {
  if (!chain || !address) return "";
  const slug = GMGN_CHAIN_SLUG[chain.toLowerCase()] ?? chain.toLowerCase();
  return `https://gmgn.ai/${slug}/token/${address}`;
}

export function gmgnWalletUrl(chain: string, address: string): string {
  if (!chain || !address) return "";
  const slug = GMGN_CHAIN_SLUG[chain.toLowerCase()] ?? chain.toLowerCase();
  return `https://gmgn.ai/${slug}/address/${address}`;
}

export function txExplorerUrl(chain: string, txHash: string): string {
  if (!chain || !txHash) return "";
  const base = TX_EXPLORER_BASE[chain.toLowerCase()];
  return base ? `${base}${txHash}` : "";
}

export async function gmgnMarketTrending(
  chain: string,
  interval = "1h",
  limit = 50
): Promise<Record<string, unknown>[]> {
  const data = await runGmgn([
    "market",
    "trending",
    "--chain",
    chain,
    "--interval",
    interval,
    "--limit",
    String(limit)
  ]);
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const rank = (data as Record<string, unknown>).rank;
    if (Array.isArray(rank)) return rank as Record<string, unknown>[];
  }
  return [];
}

const POLYHUB_DEFAULT_BASE = "https://polyhub.skill-test.bedev.hubble-rpc.xyz";
const BLOCKBEATS_PRO_BASE = "https://api-pro.theblockbeats.info";

function polyhubBases(): string[] {
  const custom = process.env.KING_AI_POLYHUB_BASE?.trim();
  return custom ? [custom, POLYHUB_DEFAULT_BASE] : [POLYHUB_DEFAULT_BASE];
}

function normalizePolyhubRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const rows = obj.rows ?? obj.data ?? obj.results;
    if (Array.isArray(rows)) return rows;
    return [obj];
  }
  return [];
}

function mapSurfLeaderboardToPolyhub(rows: unknown[]): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const addr = String(r.address ?? "");
    if (!addr) continue;
    const pnl = Number(r.pnl ?? 0);
    const volume = Number(r.volume ?? 0);
    const tradeCount = Number(r.trade_count ?? 0);
    const activity = tradeCount > 0
      ? tradeCount
      : Number(r.positions_won ?? 0) + Number(r.positions_lost ?? 0);
    const roi = volume > 0 ? pnl / volume : 0;
    mapped.push({
      user: addr,
      pnl,
      pnl_30: pnl,
      roi,
      roi_30: roi,
      trade_count_30: activity,
      trade_count_7: activity,
      tradeCount30: activity,
      timingScore: 50,
      evPerBought: volume > 0 ? pnl / volume : 0
    });
  }
  return mapped;
}

async function surfPolymarketLeaderboard(limit: number): Promise<Array<Record<string, unknown>>> {
  const resp = await runSurf(["polymarket-leaderboard", "--limit", String(limit)], 20_000);
  return mapSurfLeaderboardToPolyhub(extractSurfList(resp));
}

export async function polyhubGet(path: string, timeoutMs = 15_000): Promise<unknown[]> {
  if (!path.startsWith("http")) {
    for (const base of polyhubBases()) {
      const url = `${base}${path}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { "User-Agent": OKX_UA },
            signal: AbortSignal.timeout(timeoutMs)
          });
          if (!res.ok) continue;
          const rows = normalizePolyhubRows(await res.json());
          if (rows.length) return rows;
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
        }
      }
    }
  } else {
    try {
      const res = await fetch(path, {
        headers: { "User-Agent": OKX_UA },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.ok) return normalizePolyhubRows(await res.json());
    } catch {
      // fall through to surf fallback
    }
  }

  if (path.includes("traders-v2")) {
    const params = new URL(path, "http://local").searchParams;
    const limit = Number(params.get("limit") ?? 10);
    const rows = await surfPolymarketLeaderboard(Number.isFinite(limit) && limit > 0 ? limit : 10);
    if (rows.length) return rows;
  }
  return [];
}

export async function surfMarketTicker(symbol: string): Promise<Record<string, unknown>> {
  const pair = `${symbol.toUpperCase()}/USDT`;
  const resp = await runSurf(["exchange-price", "--pair", pair, "--exchange", "okx"], 15_000);
  const row = extractSurfList(resp)[0];
  if (!row || typeof row !== "object") return {};
  const r = row as Record<string, unknown>;
  const last = Number(r.last ?? 0);
  const changePct = Number(r.change_24h_pct ?? 0);
  const open24h = Number.isFinite(last) && Number.isFinite(changePct) && changePct !== 0
    ? last / (1 + changePct / 100)
    : last;
  return {
    last: String(last),
    open24h: String(open24h)
  };
}

export async function surfFundingRate(symbol: string): Promise<Record<string, unknown>> {
  const pair = `${symbol.toUpperCase()}/USDT`;
  const resp = await runSurf(["exchange-perp", "--pair", pair, "--exchange", "okx", "--fields", "funding"], 15_000);
  const data = extractSurfObject(resp);
  const funding = (data.funding ?? {}) as Record<string, unknown>;
  return { fundingRate: funding.funding_rate ?? "" };
}

export async function surfOptionsData(symbol = "BTC"): Promise<Array<Record<string, unknown>>> {
  const resp = await runSurf(["market-options", "--symbol", symbol.toUpperCase()], 20_000);
  return extractSurfList(resp) as Array<Record<string, unknown>>;
}

export async function blockbeatsProGet(path: string, params?: Record<string, string>, timeoutMs = 15_000): Promise<unknown> {
  const apiKey = process.env.BLOCKBEATS_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  try {
    const res = await fetch(`${BLOCKBEATS_PRO_BASE}${path}${qs}`, {
      headers: { "api-key": apiKey, "User-Agent": OKX_UA },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: number; data?: unknown };
    return body.status === 0 ? body.data ?? null : null;
  } catch {
    return null;
  }
}

export interface BtcEtfRow {
  date: string;
  day_net_inflow: number;
  total_net_inflow: number;
}

export async function blockbeatsBtcEtf(timeoutMs = 15_000): Promise<BtcEtfRow[]> {
  const raw = await blockbeatsProGet("/v1/data/btc_etf", undefined, timeoutMs);
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<string, BtcEtfRow>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const date = String(r.date ?? "");
    if (!date) continue;
    const dayNet = Number.parseFloat(String(r.day_net_inflow_million ?? 0));
    const totalNet = Number.parseFloat(String(r.total_net_inflow_million ?? 0));
    if (!Number.isFinite(dayNet) || !Number.isFinite(totalNet)) continue;
    byDate.set(date, { date, day_net_inflow: dayNet, total_net_inflow: totalNet });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function gmgnTokenSecurity(chain: string, address: string): Promise<Record<string, unknown>> {
  const data = await runGmgn(["token", "security", "--chain", chain, "--address", address], 30_000);
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

export async function gmgnTokenInfo(chain: string, address: string): Promise<Record<string, unknown>> {
  const data = await runGmgn(["token", "info", "--chain", chain, "--address", address], 30_000);
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
}

export async function gmgnMarketTrenches(
  chain: string,
  types: string[] = ["new_creation", "completed"],
  limit = 30
): Promise<Record<string, unknown[]>> {
  const args = ["market", "trenches", "--chain", chain, "--limit", String(limit)];
  for (const t of types) args.push("--type", t);
  const data = await runGmgn(args, 30_000);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown[]>;
  }
  return {};
}

export async function fetchPolymarketPositions(addr: string, timeoutMs = 10_000): Promise<Array<Record<string, unknown>>> {
  const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(addr)}&limit=100&sortBy=CURRENT&sortOrder=desc&sizeThreshold=0.5`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": OKX_UA },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

export async function fetchPolymarketActivity(addr: string, limit = 20, timeoutMs = 10_000): Promise<Array<Record<string, unknown>>> {
  const url = `https://data-api.polymarket.com/activity?user=${encodeURIComponent(addr)}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": OKX_UA },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

export async function fetchPolymarket7dTrades(addr: string, timeoutMs = 10_000): Promise<Array<Record<string, unknown>>> {
  const cutoff = Date.now() / 1000 - 7 * 86400;
  const allTrades: Array<Record<string, unknown>> = [];
  let offset = 0;
  const batch = 100;
  for (let page = 0; page < 20; page++) {
    const url = `https://data-api.polymarket.com/activity?user=${encodeURIComponent(addr)}&limit=${batch}&offset=${offset}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": OKX_UA },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) break;
      const resp = await res.json();
      if (!Array.isArray(resp) || resp.length === 0) break;
      for (const t of resp) {
        const ts = Number((t as Record<string, unknown>).timestamp ?? 0);
        if (ts >= cutoff) allTrades.push(t as Record<string, unknown>);
      }
      const minTs = Math.min(...resp.map((t: Record<string, unknown>) => Number(t.timestamp ?? 0)));
      if (minTs < cutoff) break;
      offset += batch;
    } catch {
      break;
    }
  }
  return allTrades;
}

export async function runLast30days(query: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/workspace/github/skills/last30days-skill/skills/last30days/scripts/last30days.py`,
    `${home}/workspace/github/skills/last30days-skill/scripts/last30days.py`
  ];
  for (const script of candidates) {
    try {
      const { stdout } = await execFileP(
        "python3",
        [script, query, "--emit=json", "--quick", "--search=x"],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      const trimmed = stdout.trim();
      const jsonStart = trimmed.indexOf("{");
      if (jsonStart < 0) continue;
      const websearchMarker = trimmed.indexOf("\n====");
      const jsonStr = websearchMarker > jsonStart ? trimmed.slice(jsonStart, websearchMarker) : trimmed.slice(jsonStart);
      return JSON.parse(jsonStr) as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return {};
}

export async function sqliteQuery(dbPath: string, sql: string): Promise<unknown[][]> {
  try {
    const { stdout } = await execFileP("sqlite3", ["-json", dbPath, sql], {
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.map((row) => {
        if (row && typeof row === "object") return Object.values(row as Record<string, unknown>);
        return [row];
      });
    }
    return [];
  } catch {
    return [];
  }
}
