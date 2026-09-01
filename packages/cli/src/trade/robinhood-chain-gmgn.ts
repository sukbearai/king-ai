import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ROBINHOOD_CHAIN_GMGN_DB_PATH } from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import { ROBINHOOD_CHAIN_ID, type RpcTransport } from "./robinhood-chain.js";
import { closeSqliteDb, openSqliteDb } from "./sqlite-db.js";

export const GMGN_API_ORIGIN = "https://openapi.gmgn.ai";
export const GMGN_FIELD_RUN_REVISION = "phase2-v13-gmgn-primary";
const GMGN_SCHEMA_VERSION = "gmgn-v1";
const TRENCHES_CATEGORIES = ["new_creation", "near_completion", "completed"] as const;
const CLOCK_REFRESH_MS = 10 * 60 * 1000;
const MAX_CLOCK_RTT_MS = 10_000;
const MAX_CLOCK_OFFSET_MS = 10 * 60 * 1000;
const REQUEST_DEADLINE_MS = 15_000;

export type GmgnTrendingInterval = "1m" | "5m" | "1h";
export type GmgnTrenchesCategory = (typeof TRENCHES_CATEGORIES)[number];

export interface RobinhoodGmgnConfig {
  enabled: boolean;
  limit: number;
  maxAgeSeconds: number;
  rpcVerifyLimit: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minTrendScore: number;
  retentionDays: number;
  rpcUrls: string[];
}

export interface GmgnObservation {
  observationKey: string;
  feed: "trending" | "trenches";
  segment: GmgnTrendingInterval | GmgnTrenchesCategory;
  address: string;
  poolAddress: string | null;
  windowStart: number;
  upstreamObservedAt: number;
  ingestedAt: number;
  fresh: boolean;
  symbol: string | null;
  price: number | null;
  volume: number | null;
  swaps: number | null;
  liquidity: number | null;
  marketCap: number | null;
  holderCount: number | null;
  smartDegenCount: number | null;
  renownedCount: number | null;
  isHoneypot: boolean | null;
  isWashTrading: boolean | null;
  evidence: Record<string, unknown>;
}

export interface GmgnCandidate {
  subjectType: "token";
  subjectAddress: string;
  poolAddress: string | null;
  windowStart: number;
  state: "qualified" | "rejected";
  score: number;
  reasons: string[];
  provenance: Array<{ feed: GmgnObservation["feed"]; segment: GmgnObservation["segment"]; observationKey: string }>;
  evidence: Record<string, unknown>;
  verified: boolean;
  verificationReasons: string[];
}

export interface RobinhoodGmgnResult {
  status: "disabled" | "persisted" | "source_unhealthy";
  delivery: "shadow";
  observationsPersisted: number;
  candidatesQualified: number;
  candidatesVerified: number;
  errorCategory?: string;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value
    .map(String)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : fallback;
}

export function resolveRobinhoodGmgnConfig(config: TradeConfig): RobinhoodGmgnConfig {
  const chain = (dotGet(config, "data_sources.robinhood_chain", {}) ?? {}) as Record<string, unknown>;
  const phase1 = (dotGet(config, "data_sources.robinhood_chain.phase1", {}) ?? {}) as Record<string, unknown>;
  const rpcUrls = stringArray(
    phase1.rpc_urls,
    stringArray(chain.rpc_urls, ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"]),
  );
  return {
    enabled: chain.enabled === true && phase1.enabled === true && phase1.discovery_source === "gmgn",
    limit: boundedInt(phase1.gmgn_limit, 100, 1, 200),
    maxAgeSeconds: boundedInt(phase1.gmgn_max_age_seconds, 600, 60, 600),
    rpcVerifyLimit: boundedInt(phase1.gmgn_rpc_verify_limit, 20, 1, 20),
    minLiquidityUsd: boundedNumber(phase1.min_liquidity_usd, 25_000, 0, 100_000_000),
    minVolume5mUsd: boundedNumber(phase1.min_volume_5m_usd, 10_000, 0, 100_000_000),
    minTrendScore: boundedNumber(phase1.min_trend_score, 50, 0, 100),
    retentionDays: boundedInt(phase1.retention_days, 30, 7, 90),
    rpcUrls,
  };
}

export function readGmgnApiKey(env: { GMGN_API_KEY?: string } = process.env): string {
  const value = env.GMGN_API_KEY?.trim();
  if (!value) throw new Error("GMGN_API_KEY is required for GMGN discovery");
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function successful(value: unknown): boolean {
  return value === undefined || value === null || value === 0 || value === "0";
}

function explicitSuccess(value: unknown): boolean {
  return value === 0 || value === "0";
}

function address(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.toLowerCase() : "";
  return /^0x[0-9a-f]{40}$/.test(normalized) ? normalized : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function booleanOrNull(value: unknown): boolean | null {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  return null;
}

function first(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}

function segmentSeconds(segment: GmgnObservation["segment"]): number {
  if (segment === "5m") return 300;
  if (segment === "1h") return 3600;
  return 60;
}

function normalizeRow(
  row: Record<string, unknown>,
  feed: GmgnObservation["feed"],
  segment: GmgnObservation["segment"],
  upstreamObservedAt: number,
  ingestedAt: number,
  maxAgeSeconds: number,
): GmgnObservation | null {
  const tokenAddress = address(first(row, "address", "token_address", "tokenAddress"));
  if (!tokenAddress) return null;
  const poolAddress = address(first(row, "pool_address", "poolAddress", "pair_address", "pairAddress"));
  const windowStart = Math.floor(upstreamObservedAt / segmentSeconds(segment)) * segmentSeconds(segment);
  const evidence: Record<string, unknown> = { source: "gmgn", endpointKind: feed, segment };
  for (const key of [
    "created_at",
    "open_at",
    "launchpad",
    "launchpad_status",
    "holder_top10_ratio",
    "insider_ratio",
    "bundler_ratio",
    "sniper_ratio",
    "bot_ratio",
    "fresh_wallet_ratio",
    "social_links",
    "is_social_duplicate",
  ]) {
    if (Object.hasOwn(row, key)) evidence[key] = row[key];
  }
  return {
    observationKey: `gmgn:${feed}:${segment}:${tokenAddress}:${windowStart}`,
    feed,
    segment,
    address: tokenAddress,
    poolAddress,
    windowStart,
    upstreamObservedAt,
    ingestedAt,
    fresh: Math.abs(ingestedAt - upstreamObservedAt) <= maxAgeSeconds,
    symbol: typeof row.symbol === "string" ? row.symbol.slice(0, 100) : null,
    price: numberOrNull(first(row, "price")),
    volume: numberOrNull(first(row, "volume", "volume_5m", "volume_24h")),
    swaps: numberOrNull(first(row, "swaps", "swaps_5m", "swaps_24h")),
    liquidity: numberOrNull(first(row, "liquidity", "liquidity_usd")),
    marketCap: numberOrNull(first(row, "market_cap", "marketCap", "market_cap_usd")),
    holderCount: numberOrNull(first(row, "holder_count", "holders", "holderCount")),
    smartDegenCount: numberOrNull(first(row, "smart_degen_count", "smartDegenCount")),
    renownedCount: numberOrNull(first(row, "renowned_count", "renownedCount")),
    isHoneypot: booleanOrNull(first(row, "is_honeypot", "isHoneypot")),
    isWashTrading: booleanOrNull(first(row, "is_wash_trading", "isWashTrading")),
    evidence,
  };
}

function readTrendingRows(payload: unknown): unknown[] {
  const outer = asRecord(payload);
  const inner = asRecord(outer?.data);
  const data = asRecord(inner?.data);
  if (!explicitSuccess(outer?.code) || !explicitSuccess(inner?.code) || !Array.isArray(data?.rank)) {
    throw new Error("invalid GMGN trending envelope");
  }
  return data.rank;
}

export function normalizeGmgnTrending(
  payload: unknown,
  interval: GmgnTrendingInterval,
  upstreamObservedAt: number,
  ingestedAt: number,
  limit: number,
  maxAgeSeconds: number,
): GmgnObservation[] {
  const observations: GmgnObservation[] = [];
  const hardLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  for (const value of readTrendingRows(payload)) {
    const row = asRecord(value);
    const normalized = row
      ? normalizeRow(row, "trending", interval, upstreamObservedAt, ingestedAt, maxAgeSeconds)
      : null;
    if (normalized) observations.push(normalized);
    if (observations.length >= hardLimit) break;
  }
  return observations;
}

function readTrenches(payload: unknown): Record<GmgnTrenchesCategory, unknown[]> {
  let current = asRecord(payload);
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (!successful(current.code)) throw new Error("invalid GMGN trenches envelope status");
    if (
      Array.isArray(current.new_creation) &&
      Array.isArray(current.completed) &&
      (Array.isArray(current.near_completion) || Array.isArray(current.pump))
    ) {
      return {
        new_creation: current.new_creation,
        near_completion: (current.near_completion ?? current.pump) as unknown[],
        completed: current.completed,
      };
    }
    current = asRecord(current.data);
  }
  throw new Error("invalid GMGN trenches envelope");
}

export function normalizeGmgnTrenches(
  payload: unknown,
  upstreamObservedAt: number,
  ingestedAt: number,
  limit: number,
  maxAgeSeconds: number,
): GmgnObservation[] {
  const envelope = readTrenches(payload);
  const observations: GmgnObservation[] = [];
  const hardLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
  for (const category of TRENCHES_CATEGORIES) {
    let categoryCount = 0;
    for (const value of envelope[category]) {
      const row = asRecord(value);
      const normalized = row
        ? normalizeRow(row, "trenches", category, upstreamObservedAt, ingestedAt, maxAgeSeconds)
        : null;
      if (normalized) {
        observations.push(normalized);
        categoryCount += 1;
      }
      if (categoryCount >= hardLimit) break;
    }
  }
  return observations;
}

function candidateWindow(observation: GmgnObservation): number {
  return Math.floor(observation.windowStart / 300) * 300;
}

export function buildGmgnCandidates(
  observations: readonly GmgnObservation[],
  config: Pick<RobinhoodGmgnConfig, "minLiquidityUsd" | "minVolume5mUsd" | "minTrendScore">,
): GmgnCandidate[] {
  const groups = new Map<string, GmgnObservation[]>();
  for (const observation of observations) {
    const key = `${observation.address}:${candidateWindow(observation)}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  const candidates: GmgnCandidate[] = [];
  for (const values of groups.values()) {
    const fiveMinute = values.find((value) => value.feed === "trending" && value.segment === "5m");
    if (!fiveMinute) continue;
    const oneMinute = values.find((value) => value.fresh && value.feed === "trending" && value.segment === "1m");
    const trenches = values.filter((value) => value.fresh && value.feed === "trenches");
    const reasons: string[] = [];
    if (!fiveMinute.fresh) reasons.push("five_minute_stale");
    if (!oneMinute && trenches.length === 0) reasons.push("corroboration_missing");
    if (fiveMinute.volume == null) reasons.push("volume_unknown");
    else if (fiveMinute.volume < config.minVolume5mUsd) reasons.push("volume_below_minimum");
    if (fiveMinute.liquidity == null) reasons.push("liquidity_unknown");
    else if (fiveMinute.liquidity < config.minLiquidityUsd) reasons.push("liquidity_below_minimum");
    if (fiveMinute.swaps == null) reasons.push("swaps_unknown");
    else if (fiveMinute.swaps <= 0) reasons.push("swaps_not_positive");
    if (fiveMinute.holderCount == null) reasons.push("holder_count_unknown");
    else if (fiveMinute.holderCount <= 0) reasons.push("holder_count_not_positive");
    if (fiveMinute.isHoneypot == null) reasons.push("honeypot_status_unknown");
    else if (fiveMinute.isHoneypot) reasons.push("honeypot_detected");
    if (fiveMinute.isWashTrading == null) reasons.push("wash_trading_status_unknown");
    else if (fiveMinute.isWashTrading) reasons.push("wash_trading_detected");
    const pools = [...new Set(values.map((value) => value.poolAddress).filter((value): value is string => !!value))];
    if (pools.length > 1) reasons.push("pool_address_conflict");
    let score = 50 + (oneMinute ? 20 : 0);
    if (trenches.some((value) => value.segment === "new_creation" || value.segment === "near_completion")) score += 15;
    else if (trenches.some((value) => value.segment === "completed")) score += 10;
    if ((fiveMinute.smartDegenCount ?? 0) > 0) score += 5;
    if ((fiveMinute.renownedCount ?? 0) > 0) score += 5;
    score = Math.min(100, score);
    if (score < config.minTrendScore) reasons.push("trend_score_below_minimum");
    const provenance = [...values]
      .sort((left, right) => left.observationKey.localeCompare(right.observationKey))
      .map((value) => ({ feed: value.feed, segment: value.segment, observationKey: value.observationKey }));
    candidates.push({
      subjectType: "token",
      subjectAddress: fiveMinute.address,
      poolAddress: pools[0] ?? null,
      windowStart: fiveMinute.windowStart,
      state: reasons.length === 0 ? "qualified" : "rejected",
      score,
      reasons,
      provenance,
      evidence: {
        source: "gmgn",
        symbol: fiveMinute.symbol,
        price: fiveMinute.price,
        volume5mUsd: fiveMinute.volume,
        swaps5m: fiveMinute.swaps,
        liquidityUsd: fiveMinute.liquidity,
        marketCapUsd: fiveMinute.marketCap,
        holderCount: fiveMinute.holderCount,
        smartDegenCount: fiveMinute.smartDegenCount,
        renownedCount: fiveMinute.renownedCount,
      },
      verified: false,
      verificationReasons: [],
    });
  }
  return candidates.sort(
    (left, right) => right.score - left.score || left.subjectAddress.localeCompare(right.subjectAddress),
  );
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("gmgn_request_aborted"));
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("gmgn_request_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function serverDate(response: Response): number {
  const raw = response.headers.get("date");
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new Error("gmgn_clock_date_invalid");
  return parsed;
}

function category(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.match(/(?:gmgn|rpc)_[a-z0-9_]+/i)?.[0] ?? "gmgn_unknown_error").toLowerCase().slice(0, 100);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("gmgn_schema_drift");
  }
}

function timestampExpired(payload: unknown): boolean {
  const data = asRecord(payload);
  return [data?.error, data?.message, data?.code].some((value) =>
    /auth_timestamp_expired|timestamp expired/i.test(String(value ?? "")),
  );
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  const seconds = Number(raw);
  return raw && Number.isFinite(seconds) && seconds >= 0 && seconds <= 5 ? Math.round(seconds * 1000) : null;
}

export class GmgnOpenApiClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly uuid: () => string;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private clockOffsetMs: number | null = null;
  private clockSyncedAtMs = 0;
  private clockSync: Promise<void> | null = null;

  constructor(options: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    nowMs?: () => number;
    uuid?: () => string;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }) {
    if (!options.apiKey.trim()) throw new Error("GMGN_API_KEY is required for GMGN discovery");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowMs = options.nowMs ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.sleep = options.sleep ?? abortableSleep;
  }

  private async syncClock(signal?: AbortSignal): Promise<void> {
    const started = this.nowMs();
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(MAX_CLOCK_RTT_MS);
      response = await this.fetchImpl(`${GMGN_API_ORIGIN}/`, {
        method: "HEAD",
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new Error(signal?.aborted ? "gmgn_request_aborted" : "gmgn_clock_transport_error");
    }
    const ended = this.nowMs();
    if (ended - started < 0 || ended - started > MAX_CLOCK_RTT_MS) throw new Error("gmgn_clock_round_trip_invalid");
    const offset = serverDate(response) - (started + (ended - started) / 2);
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_MS) throw new Error("gmgn_clock_offset_invalid");
    this.clockOffsetMs = offset;
    this.clockSyncedAtMs = ended;
  }

  private async ensureClock(signal?: AbortSignal, force = false): Promise<void> {
    if (!force && this.clockOffsetMs != null && this.nowMs() - this.clockSyncedAtMs < CLOCK_REFRESH_MS) return;
    if (this.clockSync) return this.clockSync;
    const task = this.syncClock(signal);
    const tracked = task.finally(() => {
      if (this.clockSync === tracked) this.clockSync = null;
    });
    this.clockSync = tracked;
    return tracked;
  }

  private adjustedNowMs(): number {
    if (this.clockOffsetMs == null) throw new Error("gmgn_clock_unavailable");
    return this.nowMs() + this.clockOffsetMs;
  }

  private async request(
    endpoint: "trending" | "trenches",
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ payload: unknown; upstreamObservedAt: number }> {
    const deadline = this.nowMs() + REQUEST_DEADLINE_MS;
    let replayedTimestamp = false;
    let attempt = 0;
    await this.ensureClock(signal);
    while (attempt < 3) {
      attempt += 1;
      if (signal?.aborted) throw new Error("gmgn_request_aborted");
      const remaining = deadline - this.nowMs();
      if (remaining <= 0) throw new Error(`gmgn_${endpoint}_deadline_exceeded`);
      const url = new URL(path, GMGN_API_ORIGIN);
      url.searchParams.set("timestamp", String(Math.floor(this.adjustedNowMs() / 1000)));
      url.searchParams.set("client_id", this.uuid());
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(remaining, REQUEST_DEADLINE_MS)));
        response = await this.fetchImpl(url, {
          ...init,
          headers: { accept: "application/json", "X-APIKEY": this.apiKey, ...init.headers },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        if (signal?.aborted) throw new Error("gmgn_request_aborted");
        if (attempt >= 3) throw new Error(`gmgn_${endpoint}_transport_exhausted`);
        await this.sleep(Math.min(1000, 250 * 2 ** (attempt - 1)), signal);
        continue;
      }
      const upstreamObservedAt = Math.floor(serverDate(response) / 1000);
      const payload = await responseJson(response);
      if (response.ok) return { payload, upstreamObservedAt };
      if ((response.status === 401 || response.status === 403) && timestampExpired(payload) && !replayedTimestamp) {
        replayedTimestamp = true;
        await this.ensureClock(signal, true);
        attempt -= 1;
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new Error("gmgn_auth_denied");
      if (response.status === 429) {
        const waitMs = retryAfter(response);
        if (waitMs == null || attempt >= 3 || this.nowMs() + waitMs >= deadline)
          throw new Error("gmgn_rate_limit_exhausted");
        await this.sleep(waitMs, signal);
        continue;
      }
      if (response.status >= 500 && attempt < 3) {
        await this.sleep(Math.min(1000, 250 * 2 ** (attempt - 1)), signal);
        continue;
      }
      throw new Error(`gmgn_${endpoint}_http_error`);
    }
    throw new Error(`gmgn_${endpoint}_attempts_exhausted`);
  }

  getTrending(interval: GmgnTrendingInterval, limit: number, signal?: AbortSignal) {
    return this.request(
      "trending",
      `/v1/market/rank?chain=robinhood&interval=${interval}&limit=${Math.min(200, Math.max(1, Math.trunc(limit)))}`,
      { method: "GET" },
      signal,
    );
  }

  getTrenches(limit: number, signal?: AbortSignal) {
    const section = {
      filters: ["offchain", "onchain"],
      launchpad_platform_v2: true,
      limit: Math.min(200, Math.max(1, Math.trunc(limit))),
      quote_address_type: [11, 20, 24, 12, 0],
    };
    return this.request(
      "trenches",
      "/v1/trenches?chain=robinhood",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          version: "v2",
          new_creation: section,
          near_completion: section,
          completed: section,
        }),
      },
      signal,
    );
  }
}

function defaultRpcTransport(signal?: AbortSignal): RpcTransport {
  return async (url, method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("rpc_http_error");
    const payload = asRecord(await response.json());
    if (!payload || payload.error || !Object.hasOwn(payload, "result")) throw new Error("rpc_response_error");
    return payload.result;
  };
}

async function callRpc(
  urls: readonly string[],
  transport: RpcTransport,
  method: string,
  params: unknown[],
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const url of urls) {
      if (signal?.aborted) throw new Error("gmgn_request_aborted");
      try {
        return await transport(url, method, params);
      } catch {
        if (signal?.aborted) throw new Error("gmgn_request_aborted");
        // Try the next bounded endpoint.
      }
    }
    if (attempt === 0) await sleep(250, signal);
  }
  throw new Error("rpc_verification_failed");
}

function hasCode(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && !/^0x0*$/i.test(value);
}

function matchesRobinhoodChainId(value: unknown): boolean {
  return typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) === BigInt(ROBINHOOD_CHAIN_ID);
}

export async function verifyGmgnCandidates(
  candidates: readonly GmgnCandidate[],
  options: {
    rpcUrls: string[];
    transport: RpcTransport;
    maxAddresses?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<GmgnCandidate[]> {
  if (candidates.length === 0) return [];
  const maxAddresses = Math.min(20, Math.max(1, Math.trunc(options.maxAddresses ?? 20)));
  const sleep = options.sleep ?? abortableSleep;
  let chainValid = false;
  try {
    const chainId = await callRpc(options.rpcUrls, options.transport, "eth_chainId", [], sleep, options.signal);
    chainValid = matchesRobinhoodChainId(chainId);
  } catch {
    if (options.signal?.aborted) throw new Error("gmgn_request_aborted");
    chainValid = false;
  }
  const checked = new Map<string, boolean>();
  const verifyAddress = async (value: string): Promise<boolean | null> => {
    if (checked.has(value)) return checked.get(value)!;
    if (checked.size >= maxAddresses) return null;
    let valid = false;
    try {
      valid = hasCode(
        await callRpc(options.rpcUrls, options.transport, "eth_getCode", [value, "latest"], sleep, options.signal),
      );
    } catch {
      if (options.signal?.aborted) throw new Error("gmgn_request_aborted");
      valid = false;
    }
    checked.set(value, valid);
    return valid;
  };
  const output: GmgnCandidate[] = [];
  for (const candidate of candidates) {
    const copy = { ...candidate, verificationReasons: [...candidate.verificationReasons] };
    if (candidate.state !== "qualified") {
      output.push(copy);
      continue;
    }
    if (!chainValid) {
      copy.verificationReasons.push("rpc_chain_id_mismatch_or_unavailable");
      output.push(copy);
      continue;
    }
    const tokenValid = await verifyAddress(candidate.subjectAddress);
    if (tokenValid == null) copy.verificationReasons.push("rpc_verify_limit_reached");
    else if (!tokenValid) copy.verificationReasons.push("token_bytecode_missing");
    if (candidate.poolAddress) {
      const poolValid = await verifyAddress(candidate.poolAddress);
      if (poolValid == null) copy.verificationReasons.push("rpc_verify_limit_reached");
      else if (!poolValid) copy.verificationReasons.push("pool_bytecode_missing");
    }
    copy.verified = copy.verificationReasons.length === 0;
    output.push(copy);
  }
  return output;
}

export class RobinhoodGmgnStore {
  private readonly db;

  constructor(readonly path: string) {
    this.db = openSqliteDb(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmgn_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gmgn_observations (
        observation_key TEXT PRIMARY KEY,feed TEXT NOT NULL,segment TEXT NOT NULL,address TEXT NOT NULL,
        pool_address TEXT,window_start INTEGER NOT NULL,upstream_observed_at INTEGER NOT NULL,
        ingested_at INTEGER NOT NULL,fresh INTEGER NOT NULL,symbol TEXT,price REAL,volume REAL,swaps REAL,
        liquidity REAL,market_cap REAL,holder_count REAL,smart_degen_count REAL,renowned_count REAL,
        is_honeypot INTEGER,is_wash_trading INTEGER,evidence_json TEXT NOT NULL,field_run_revision TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gmgn_observations_address_window_idx
      ON gmgn_observations(address,window_start,feed,segment);
      CREATE TABLE IF NOT EXISTS gmgn_candidates (
        subject_type TEXT NOT NULL,subject_address TEXT NOT NULL,pool_address TEXT,window_start INTEGER NOT NULL,
        state TEXT NOT NULL,score REAL NOT NULL,reasons_json TEXT NOT NULL,provenance_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,verified INTEGER NOT NULL,verification_reasons_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,field_run_revision TEXT NOT NULL,
        PRIMARY KEY(subject_type,subject_address,window_start,field_run_revision)
      );
      CREATE INDEX IF NOT EXISTS gmgn_candidates_state_window_idx
      ON gmgn_candidates(field_run_revision,state,verified,window_start);
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY,status TEXT NOT NULL,upstream_observed_at INTEGER,last_success_at INTEGER,
        consecutive_failures INTEGER NOT NULL,last_error_at INTEGER,error_category TEXT,field_run_revision TEXT NOT NULL
      );
    `);
    this.db
      .prepare("INSERT OR REPLACE INTO gmgn_metadata (key,value) VALUES ('schema_version',?)")
      .run(GMGN_SCHEMA_VERSION);
  }

  persistTick(input: {
    observations: readonly GmgnObservation[];
    candidates: readonly GmgnCandidate[];
    now: number;
    retentionDays: number;
  }): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const observation = this.db.prepare(`
        INSERT INTO gmgn_observations (
          observation_key,feed,segment,address,pool_address,window_start,upstream_observed_at,ingested_at,fresh,
          symbol,price,volume,swaps,liquidity,market_cap,holder_count,smart_degen_count,renowned_count,
          is_honeypot,is_wash_trading,evidence_json,field_run_revision
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(observation_key) DO UPDATE SET pool_address=excluded.pool_address,
        upstream_observed_at=excluded.upstream_observed_at,ingested_at=excluded.ingested_at,fresh=excluded.fresh,
        symbol=excluded.symbol,price=excluded.price,volume=excluded.volume,swaps=excluded.swaps,
        liquidity=excluded.liquidity,market_cap=excluded.market_cap,holder_count=excluded.holder_count,
        smart_degen_count=excluded.smart_degen_count,renowned_count=excluded.renowned_count,
        is_honeypot=excluded.is_honeypot,is_wash_trading=excluded.is_wash_trading,
        evidence_json=excluded.evidence_json,field_run_revision=excluded.field_run_revision
      `);
      for (const row of input.observations) {
        observation.run(
          row.observationKey,
          row.feed,
          row.segment,
          row.address,
          row.poolAddress,
          row.windowStart,
          row.upstreamObservedAt,
          row.ingestedAt,
          row.fresh ? 1 : 0,
          row.symbol,
          row.price,
          row.volume,
          row.swaps,
          row.liquidity,
          row.marketCap,
          row.holderCount,
          row.smartDegenCount,
          row.renownedCount,
          row.isHoneypot == null ? null : row.isHoneypot ? 1 : 0,
          row.isWashTrading == null ? null : row.isWashTrading ? 1 : 0,
          JSON.stringify(row.evidence),
          GMGN_FIELD_RUN_REVISION,
        );
      }
      const candidate = this.db.prepare(`
        INSERT INTO gmgn_candidates (
          subject_type,subject_address,pool_address,window_start,state,score,reasons_json,provenance_json,
          evidence_json,verified,verification_reasons_json,updated_at,field_run_revision
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(subject_type,subject_address,window_start,field_run_revision) DO UPDATE SET
        pool_address=excluded.pool_address,state=excluded.state,score=excluded.score,reasons_json=excluded.reasons_json,
        provenance_json=excluded.provenance_json,evidence_json=excluded.evidence_json,verified=excluded.verified,
        verification_reasons_json=excluded.verification_reasons_json,updated_at=excluded.updated_at
      `);
      for (const row of input.candidates) {
        candidate.run(
          row.subjectType,
          row.subjectAddress,
          row.poolAddress,
          row.windowStart,
          row.state,
          row.score,
          JSON.stringify(row.reasons),
          JSON.stringify(row.provenance),
          JSON.stringify(row.evidence),
          row.verified ? 1 : 0,
          JSON.stringify(row.verificationReasons),
          input.now,
          GMGN_FIELD_RUN_REVISION,
        );
      }
      const upstream = input.observations.reduce((latest, row) => Math.max(latest, row.upstreamObservedAt), 0);
      this.db
        .prepare(`
        INSERT INTO source_health (
          source,status,upstream_observed_at,last_success_at,consecutive_failures,last_error_at,error_category,field_run_revision
        ) VALUES ('gmgn','ok',?,?,0,NULL,NULL,?)
        ON CONFLICT(source) DO UPDATE SET status='ok',upstream_observed_at=excluded.upstream_observed_at,
        last_success_at=excluded.last_success_at,consecutive_failures=0,last_error_at=NULL,error_category=NULL,
        field_run_revision=excluded.field_run_revision
      `)
        .run(upstream || null, input.now, GMGN_FIELD_RUN_REVISION);
      const cutoff = input.now - input.retentionDays * 86400;
      this.db.prepare("DELETE FROM gmgn_observations WHERE upstream_observed_at<?").run(cutoff);
      this.db.prepare("DELETE FROM gmgn_candidates WHERE window_start<?").run(cutoff);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordFailure(now: number, errorCategory: string): void {
    this.db
      .prepare(`
      INSERT INTO source_health (
        source,status,upstream_observed_at,last_success_at,consecutive_failures,last_error_at,error_category,field_run_revision
      ) VALUES ('gmgn','error',NULL,NULL,1,?,?,?)
      ON CONFLICT(source) DO UPDATE SET status='error',consecutive_failures=source_health.consecutive_failures+1,
      last_error_at=excluded.last_error_at,error_category=excluded.error_category,field_run_revision=excluded.field_run_revision
    `)
      .run(now, errorCategory.slice(0, 100), GMGN_FIELD_RUN_REVISION);
  }

  count(table: "gmgn_observations" | "gmgn_candidates"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number };
    return Number(row.count ?? 0);
  }

  sourceHealth(): Record<string, unknown> | null {
    return (
      (this.db.prepare("SELECT * FROM source_health WHERE source='gmgn'").get() as Record<string, unknown>) ?? null
    );
  }

  close(): void {
    closeSqliteDb(this.path);
  }
}

export async function collectRobinhoodGmgn(options: {
  config: TradeConfig;
  dbPath?: string;
  signal?: AbortSignal;
  client?: Pick<GmgnOpenApiClient, "getTrending" | "getTrenches">;
  transport?: RpcTransport;
  now?: () => number;
}): Promise<RobinhoodGmgnResult> {
  const config = resolveRobinhoodGmgnConfig(options.config);
  if (!config.enabled) {
    return {
      status: "disabled",
      delivery: "shadow",
      observationsPersisted: 0,
      candidatesQualified: 0,
      candidatesVerified: 0,
    };
  }
  const path = options.dbPath ?? ROBINHOOD_CHAIN_GMGN_DB_PATH;
  await mkdir(dirname(path), { recursive: true });
  const store = new RobinhoodGmgnStore(path);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  try {
    const client = options.client ?? new GmgnOpenApiClient({ apiKey: readGmgnApiKey() });
    const settled = await Promise.allSettled([
      client.getTrending("1m", config.limit, options.signal),
      client.getTrending("5m", config.limit, options.signal),
      client.getTrending("1h", config.limit, options.signal),
      client.getTrenches(config.limit, options.signal),
    ]);
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const [oneMinute, fiveMinute, oneHour, trenches] = settled.map(
      (result) => (result as PromiseFulfilledResult<{ payload: unknown; upstreamObservedAt: number }>).value,
    );
    if (options.signal?.aborted) throw new Error("gmgn_request_aborted");
    const ingestedAt = now();
    const responses = [oneMinute, fiveMinute, oneHour, trenches];
    if (responses.some((response) => Math.abs(ingestedAt - response.upstreamObservedAt) > config.maxAgeSeconds)) {
      throw new Error("gmgn_upstream_stale");
    }
    const observations = [
      ...normalizeGmgnTrending(
        oneMinute.payload,
        "1m",
        oneMinute.upstreamObservedAt,
        ingestedAt,
        config.limit,
        config.maxAgeSeconds,
      ),
      ...normalizeGmgnTrending(
        fiveMinute.payload,
        "5m",
        fiveMinute.upstreamObservedAt,
        ingestedAt,
        config.limit,
        config.maxAgeSeconds,
      ),
      ...normalizeGmgnTrending(
        oneHour.payload,
        "1h",
        oneHour.upstreamObservedAt,
        ingestedAt,
        config.limit,
        config.maxAgeSeconds,
      ),
      ...normalizeGmgnTrenches(
        trenches.payload,
        trenches.upstreamObservedAt,
        ingestedAt,
        config.limit,
        config.maxAgeSeconds,
      ),
    ];
    const candidates = buildGmgnCandidates(observations, config);
    const verified = await verifyGmgnCandidates(candidates, {
      rpcUrls: config.rpcUrls,
      transport: options.transport ?? defaultRpcTransport(options.signal),
      maxAddresses: config.rpcVerifyLimit,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new Error("gmgn_request_aborted");
    store.persistTick({ observations, candidates: verified, now: ingestedAt, retentionDays: config.retentionDays });
    return {
      status: "persisted",
      delivery: "shadow",
      observationsPersisted: observations.length,
      candidatesQualified: verified.filter((row) => row.state === "qualified").length,
      candidatesVerified: verified.filter((row) => row.state === "qualified" && row.verified).length,
    };
  } catch (error) {
    const errorCategory = category(error);
    store.recordFailure(now(), errorCategory);
    return {
      status: "source_unhealthy",
      delivery: "shadow",
      observationsPersisted: 0,
      candidatesQualified: 0,
      candidatesVerified: 0,
      errorCategory,
    };
  } finally {
    store.close();
  }
}
