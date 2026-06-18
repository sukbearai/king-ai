import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliFailure, cliSuccess, type CliRunResult } from "./cli-result.js";
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

interface ExecFileError extends Error {
  stdout?: string;
  stderr?: string;
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

function logCliFailure(bin: string, args: string[], err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${bin}] ${args.join(" ")} failed: ${msg}\n`);
}

export async function runTg(args: string[], timeoutMs = 60_000): Promise<CliRunResult<string>> {
  try {
    return cliSuccess(await runCli("tg", args, timeoutMs));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logCliFailure("tg", args, err);
    return cliFailure("", msg);
  }
}

// onchainos emits a structured `{ ok: false, error }` on stdout when a call
// fails, while transient auth/network blips (e.g. "Failed to refresh session …
// Falling back to API key auth") may surface as a non-zero exit. Prefer that
// structured message over the opaque "Command failed: …", and retry a few
// times so a single flaky refresh/fallback doesn't sink the whole section.
function onchainosError(parsed: unknown): string | undefined {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if (obj.ok === false) return String(obj.error ?? "onchainos returned ok:false");
  }
  return undefined;
}

export async function runOnchainos(
  args: string[],
  timeoutMs = 15_000,
  attempts = 3
): Promise<CliRunResult<unknown>> {
  let lastError = "onchainos call failed";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const parsed = parseCliJson(await runCli("onchainos", args, timeoutMs));
      const structured = onchainosError(parsed);
      if (!structured) return cliSuccess(parsed);
      lastError = structured;
    } catch (err) {
      const e = err as ExecFileError;
      const structured = e.stdout ? onchainosError(parseCliJson(e.stdout)) : undefined;
      lastError = structured ?? (err instanceof Error ? err.message : String(err));
    }
    if (attempt < attempts - 1) {
      await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    }
  }
  logCliFailure("onchainos", args, lastError);
  return cliFailure({}, lastError);
}

export async function runOpencli(args: string[], timeoutMs = 90_000): Promise<CliRunResult<unknown[]>> {
  try {
    const out = await runCli("opencli", args, timeoutMs);
    const parsed = parseCliJson(out);
    const data = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : [];
    return cliSuccess(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logCliFailure("opencli", args, err);
    return cliFailure([], msg);
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
      chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number; chartPreviousClose?: number } }> };
    };
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? 0;
    const prev = meta?.previousClose ?? meta?.chartPreviousClose ?? 0;
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
