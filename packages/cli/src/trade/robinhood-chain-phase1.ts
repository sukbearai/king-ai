import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ROBINHOOD_CHAIN_PHASE1_DB_PATH } from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import {
  ROBINHOOD_CHAIN_ID,
  resolveRobinhoodChainConfig,
  sanitizeRpcUrl,
  WrongChainError,
  type RpcTransport,
} from "./robinhood-chain.js";
import { closeSqliteDb, openSqliteDb } from "./sqlite-db.js";
import { fetchTweets } from "./rules/rule-t-celebrity.js";

const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const V2_SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const V3_POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const UP_POOL_CREATED_TOPIC = "0xab0d57f0df537bb25e80245ef7748fa62353808c54d6e528a9dd20887aed9ac2";
const V3_SWAP_TOPIC = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const V4_INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const V4_SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const METRIC_POOL_CREATED_TOPIC = "0x4b36a0ddce54edb36597ee7d496df06c53fe875aba9d7257534a38d5177899aa";
const METRIC_SWAP_TOPIC = "0x87d25816ca01843f551b4caa5eea03b5173c84c383573c63081fb7575378276e";
const GET_RESERVES_SELECTOR = "0x0902f1ac";
const BALANCE_OF_SELECTOR = "0x70a08231";
const ROBINHOOD_X_BROWSER_SESSION = "trade-robinhood-search";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const USDE = "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34";
const STABLECOIN_DECIMALS = new Map<string, number>([
  [USDG, 6],
  [USDE, 18],
]);

type ProtocolKind = "v2" | "v3" | "v4" | "metric";

export interface RobinhoodProtocolDefinition {
  id: string;
  name: string;
  enabled: boolean;
  kind: ProtocolKind;
  discoveryAddress: string;
  creationTopic: string;
  swapTopic: string;
  verifiedSource: string;
}

export const BUILTIN_ROBINHOOD_PROTOCOLS: RobinhoodProtocolDefinition[] = [
  {
    id: "uniswap_v2",
    name: "Uniswap V2",
    enabled: true,
    kind: "v2",
    discoveryAddress: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
    creationTopic: PAIR_CREATED_TOPIC,
    swapTopic: V2_SWAP_TOPIC,
    verifiedSource: "DefiLlama adapter plus Chain 4663 bytecode check 2026-08-31",
  },
  {
    id: "uniswap_v3",
    name: "Uniswap V3",
    enabled: true,
    kind: "v3",
    discoveryAddress: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    creationTopic: V3_POOL_CREATED_TOPIC,
    swapTopic: V3_SWAP_TOPIC,
    verifiedSource: "DefiLlama Uniswap V3 Robinhood deployment plus Chain 4663 bytecode check 2026-08-31",
  },
  {
    id: "uniswap_v4",
    name: "Uniswap V4",
    enabled: true,
    kind: "v4",
    discoveryAddress: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    creationTopic: V4_INITIALIZE_TOPIC,
    swapTopic: V4_SWAP_TOPIC,
    verifiedSource: "DefiLlama adapter plus Chain 4663 bytecode check 2026-08-31",
  },
  {
    id: "up_v3",
    name: "UP V3",
    enabled: true,
    kind: "v3",
    discoveryAddress: "0x1ac9db4a2608ba45d6127b1737949b51bb54b7f3",
    creationTopic: UP_POOL_CREATED_TOPIC,
    swapTopic: V3_SWAP_TOPIC,
    verifiedSource: "DefiLlama adapter plus Chain 4663 bytecode check 2026-08-31",
  },
  {
    id: "metric_v1",
    name: "Metric V1",
    enabled: true,
    kind: "metric",
    discoveryAddress: "0x622911384e7973439b8be305f5e3fc3c5736ede4",
    creationTopic: METRIC_POOL_CREATED_TOPIC,
    swapTopic: METRIC_SWAP_TOPIC,
    verifiedSource: "DefiLlama adapter plus Chain 4663 bytecode and topic check 2026-08-31",
  },
  ...[
    ["pons_v2", "Pons V2"],
    ["ramses_cl_v2", "Ramses CL V2"],
    ["giga_v3", "GIGA V3"],
    ["fables", "Fables"],
    ["alandale_v3", "Alandale V3"],
    ["sushiswap_v3", "SushiSwap V3"],
    ["orvex", "Orvex"],
    ["arcus_spot", "Arcus Spot"],
  ].map(
    ([id, name]): RobinhoodProtocolDefinition => ({
      id: id!,
      name: name!,
      enabled: false,
      kind: "v3",
      discoveryAddress: "",
      creationTopic: "",
      swapTopic: "",
      verifiedSource: "disabled until primary deployment and decoder verification",
    }),
  ),
];

export const BUILTIN_ROBINHOOD_ACCOUNTS = [
  { handle: "RobinhoodCrypto", tier: "A", category: "official" },
  { handle: "RobinhoodApp", tier: "A", category: "official" },
  { handle: "JohannKerbrat", tier: "A", category: "official" },
  { handle: "vladtenev", tier: "A", category: "official" },
  { handle: "Uniswap", tier: "B", category: "infrastructure" },
  { handle: "Morpho", tier: "B", category: "infrastructure" },
  { handle: "LayerZero_Core", tier: "B", category: "infrastructure" },
  { handle: "Lighter_xyz", tier: "B", category: "infrastructure" },
  { handle: "Paxos", tier: "B", category: "infrastructure" },
  { handle: "chainlink", tier: "B", category: "infrastructure" },
  { handle: "fablesfi", tier: "C", category: "venue" },
  { handle: "alandalexyz", tier: "C", category: "venue" },
  { handle: "giga_dex", tier: "C", category: "venue" },
  { handle: "OrvexFi", tier: "C", category: "venue" },
  { handle: "arcus_xyz", tier: "C", category: "venue" },
] as const;

export interface RobinhoodPhase1Config {
  enabled: boolean;
  delivery: "shadow";
  discoverySource: "rpc" | "gmgn";
  rpcUrls: string[];
  windowSeconds: 300;
  discoverySeconds: number;
  stablePoolDiscoveryBackfillBlocks: number;
  initialBackfillBlocks: number;
  maxLogBlocksPerTick: number;
  catchUpLagBlocks: number;
  catchUpBlocksPerTick: number;
  providerCooldownMs: number;
  maxLogBlocksPerRequest: number;
  logRpcConcurrency: number;
  reorgOverlapBlocks: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minUniqueTraders: number;
  minTrendScore: number;
  retentionDays: number;
  xEnabled: boolean;
  xCollectSeconds: number;
  xFetchLimit: number;
  xMaxAccounts: number;
  xAccounts: string[];
  backfillCollectSeconds: number;
}

export interface Phase1RpcLog {
  address: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

export interface DiscoveredPool {
  poolKey: string;
  executionAddress: string;
  protocolId: string;
  token0: string;
  token1: string;
  createdBlock: number;
  createdAt: number;
  creationEventId: string;
  quality: "verified";
}

export interface NormalizedDexEvent {
  eventId: string;
  poolKey: string;
  protocolId: string;
  eventType: "swap";
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  timestamp: number;
  trader: string;
  volumeUsd: number | null;
  liquidityUsd: number | null;
}

export interface TrendInput {
  volumeUsd: number;
  baselineVolume1hUsd: number;
  baselineVolume24hUsd: number;
  uniqueTraders: number;
  baselineUniqueTraders1h: number;
  baselineUniqueTraders24h: number;
  liquidityUsd: number | null;
  previousLiquidityUsd: number | null;
  venueBreadth: number;
  poolAgeSeconds: number;
  pricedSwapCount: number;
  swapCount: number;
  verifiedProtocol: boolean;
  sourceHealthy: boolean;
  minVolumeUsd: number;
  minLiquidityUsd: number;
  minUniqueTraders: number;
  minTrendScore?: number;
}

export interface TrendEvaluation {
  input: TrendInput;
  state: "qualified" | "rejected";
  score: number;
  reasons: string[];
  components: Record<string, number>;
}

export interface RobinhoodPhase1Result {
  status: "disabled" | "idle" | "persisted";
  delivery: "shadow";
  endpoint?: string;
  latestBlock?: number;
  targetBlock?: number;
  firstBlock?: number;
  lastBlock?: number;
  persistedBlock?: number;
  poolsDiscovered?: number;
  swapsObserved?: number;
  candidatesQualified?: number;
  realtimeFirstBlock?: number;
  realtimeLastBlock?: number;
  realtimePersistedBlock?: number;
  backfillStatus?: "skipped" | "complete" | "persisted" | "failed";
  backfillFirstBlock?: number;
  backfillLastBlock?: number;
  backfillPersistedBlock?: number;
  backfillTargetBlock?: number;
  backfillLagBlocks?: number;
  backfillError?: string;
  historyComplete?: boolean;
}

export interface RobinhoodPhase1XResult {
  status: "disabled" | "persisted";
  accountsChecked: number;
  postsObserved: number;
  health: Record<string, number>;
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

function stateNumber(value: string | null): number | undefined {
  if (value == null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function configuredStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const values = value.map((item) => String(item).trim()).filter(Boolean);
  return values.length ? values : fallback;
}

export function resolveRobinhoodPhase1Config(config: TradeConfig): RobinhoodPhase1Config {
  const phase0 = resolveRobinhoodChainConfig(config);
  const raw = (dotGet(config, "data_sources.robinhood_chain.phase1", {}) ?? {}) as Record<string, unknown>;
  const enabled = raw.enabled === true;
  const delivery = String(raw.delivery ?? "shadow");
  if (enabled && delivery !== "shadow") throw new Error("Robinhood Chain Phase 1 supports shadow delivery only");
  const discoverySource = raw.discovery_source === "gmgn" ? "gmgn" : "rpc";
  const maxLogBlocksPerTick = boundedInt(raw.max_log_blocks_per_tick, 1000, 1, 2000);
  const configuredAccounts = Array.isArray(raw.x_accounts)
    ? raw.x_accounts.map(String).map((value) => value.replace(/^@/, "").trim())
    : BUILTIN_ROBINHOOD_ACCOUNTS.map((account) => account.handle);
  const xAccounts = [...new Set(configuredAccounts.filter((value) => /^[A-Za-z0-9_]{1,15}$/.test(value)))];
  return {
    enabled,
    delivery: "shadow",
    discoverySource,
    rpcUrls: configuredStringArray(raw.rpc_urls, phase0.rpcUrls),
    windowSeconds: 300,
    discoverySeconds: boundedInt(raw.discovery_seconds, 60, 30, 3600),
    stablePoolDiscoveryBackfillBlocks: boundedInt(
      raw.stable_pool_discovery_backfill_blocks,
      1_000_000,
      10_000,
      2_000_000,
    ),
    initialBackfillBlocks: boundedInt(raw.initial_backfill_blocks, 1000, 1, 2000),
    maxLogBlocksPerTick,
    catchUpLagBlocks: boundedInt(raw.catch_up_lag_blocks, 10_000, 1_000, 1_000_000),
    catchUpBlocksPerTick: boundedInt(raw.catch_up_blocks_per_tick, 2000, 1000, 2000),
    providerCooldownMs: boundedInt(raw.provider_cooldown_ms, 5000, 0, 30_000),
    maxLogBlocksPerRequest: boundedInt(raw.max_log_blocks_per_request, 500, 10, 2000),
    logRpcConcurrency: boundedInt(raw.log_rpc_concurrency, 3, 1, 16),
    reorgOverlapBlocks: Math.min(boundedInt(raw.reorg_overlap_blocks, 20, 1, 200), maxLogBlocksPerTick),
    minLiquidityUsd: boundedNumber(raw.min_liquidity_usd, 25_000, 0, 100_000_000),
    minVolume5mUsd: boundedNumber(raw.min_volume_5m_usd, 10_000, 0, 100_000_000),
    minUniqueTraders: boundedInt(raw.min_unique_traders, 3, 1, 100_000),
    minTrendScore: boundedNumber(raw.min_trend_score, 50, 0, 100),
    retentionDays: boundedInt(raw.retention_days, 30, 7, 90),
    xEnabled: raw.x_enabled !== false,
    xCollectSeconds: boundedInt(raw.x_collect_seconds, 300, 300, 86400),
    xFetchLimit: boundedInt(raw.x_fetch_limit, 5, 1, 20),
    xMaxAccounts: boundedInt(raw.x_max_accounts, 15, 1, 50),
    xAccounts: xAccounts.length ? xAccounts : BUILTIN_ROBINHOOD_ACCOUNTS.map((account) => account.handle),
    backfillCollectSeconds: boundedInt(raw.backfill_collect_seconds, 300, 30, 3600),
  };
}

function parseHexNumber(value: unknown, field: string): number {
  const text = String(value ?? "");
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid RPC ${field}`);
  return parsed;
}

function normalizeAddress(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error("invalid EVM address");
  return normalized;
}

function topicAddress(value: string): string {
  if (!/^0x[0-9a-f]{64}$/i.test(value)) throw new Error("invalid address topic");
  return normalizeAddress(`0x${value.slice(-40)}`);
}

function addressTopic(value: string): string {
  return `0x${normalizeAddress(value).slice(2).padStart(64, "0")}`;
}

function words(data: string): string[] {
  if (!/^0x[0-9a-f]*$/i.test(data) || (data.length - 2) % 64 !== 0) throw new Error("invalid ABI data");
  const body = data.slice(2);
  return Array.from({ length: body.length / 64 }, (_, index) => body.slice(index * 64, (index + 1) * 64));
}

function wordAddress(value: string): string {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid ABI address word");
  return normalizeAddress(`0x${value.slice(-40)}`);
}

function unsignedWord(value: string): bigint {
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("invalid ABI integer word");
  return BigInt(`0x${value}`);
}

function signedWord(value: string): bigint {
  const unsigned = unsignedWord(value);
  return unsigned >= 1n << 255n ? unsigned - (1n << 256n) : unsigned;
}

function decimalAmount(value: bigint, decimals: number): number {
  const divisor = 10 ** Math.min(decimals, 18);
  const amount = Number(value < 0n ? -value : value) / divisor;
  return Number.isFinite(amount) ? amount : 0;
}

function eventId(log: Phase1RpcLog): string {
  return `${log.blockHash.toLowerCase()}:${log.transactionHash.toLowerCase()}:${parseHexNumber(log.logIndex, "log index")}`;
}

export function decodePoolCreatedLog(
  protocol: RobinhoodProtocolDefinition,
  log: Phase1RpcLog,
  timestamp: number,
): DiscoveredPool {
  if (log.topics[0]?.toLowerCase() !== protocol.creationTopic) throw new Error("unexpected creation topic");
  const blockNumber = parseHexNumber(log.blockNumber, "block number");
  const dataWords = words(log.data);
  let poolKey: string;
  let executionAddress: string;
  let token0: string;
  let token1: string;
  if (protocol.kind === "v2") {
    token0 = topicAddress(log.topics[1]!);
    token1 = topicAddress(log.topics[2]!);
    poolKey = wordAddress(dataWords[0]!);
    executionAddress = poolKey;
  } else if (protocol.kind === "v3") {
    token0 = topicAddress(log.topics[1]!);
    token1 = topicAddress(log.topics[2]!);
    poolKey = wordAddress(dataWords.at(-1)!);
    executionAddress = poolKey;
  } else if (protocol.kind === "metric") {
    poolKey = topicAddress(log.topics[1]!);
    executionAddress = poolKey;
    token0 = topicAddress(log.topics[2]!);
    token1 = topicAddress(log.topics[3]!);
  } else {
    poolKey = String(log.topics[1] ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(poolKey)) throw new Error("invalid V4 pool id");
    executionAddress = normalizeAddress(protocol.discoveryAddress);
    token0 = topicAddress(log.topics[2]!);
    token1 = topicAddress(log.topics[3]!);
  }
  return {
    poolKey,
    executionAddress,
    protocolId: protocol.id,
    token0,
    token1,
    createdBlock: blockNumber,
    createdAt: timestamp,
    creationEventId: eventId(log),
    quality: "verified",
  };
}

export function decodeSwapLog(
  protocol: RobinhoodProtocolDefinition,
  pool: DiscoveredPool,
  log: Phase1RpcLog,
  timestamp: number,
  stablecoinDecimals = STABLECOIN_DECIMALS,
  liquidityUsd: number | null = null,
): NormalizedDexEvent {
  if (log.topics[0]?.toLowerCase() !== protocol.swapTopic) throw new Error("unexpected swap topic");
  const dataWords = words(log.data);
  let amount0 = 0n;
  let amount1 = 0n;
  let traderTopic = 1;
  if (protocol.kind === "v2") {
    amount0 = unsignedWord(dataWords[0]!) + unsignedWord(dataWords[2]!);
    amount1 = unsignedWord(dataWords[1]!) + unsignedWord(dataWords[3]!);
  } else if (protocol.kind === "metric") {
    amount0 = signedWord(dataWords[1]!);
    amount1 = signedWord(dataWords[2]!);
  } else {
    amount0 = signedWord(dataWords[0]!);
    amount1 = signedWord(dataWords[1]!);
    traderTopic = protocol.kind === "v4" ? 2 : 1;
  }
  const stable0Decimals = stablecoinDecimals.get(pool.token0);
  const stable1Decimals = stablecoinDecimals.get(pool.token1);
  const volumeUsd =
    stable0Decimals != null
      ? decimalAmount(amount0, stable0Decimals)
      : stable1Decimals != null
        ? decimalAmount(amount1, stable1Decimals)
        : null;
  return {
    eventId: eventId(log),
    poolKey: pool.poolKey,
    protocolId: protocol.id,
    eventType: "swap",
    blockNumber: parseHexNumber(log.blockNumber, "block number"),
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    logIndex: parseHexNumber(log.logIndex, "log index"),
    timestamp,
    trader: topicAddress(log.topics[traderTopic]!),
    volumeUsd,
    liquidityUsd,
  };
}

export function evaluateTrendCandidate(input: TrendInput): TrendEvaluation {
  const reasons: string[] = [];
  const pricedCoverage = input.swapCount > 0 ? input.pricedSwapCount / input.swapCount : 0;
  if (!input.verifiedProtocol) reasons.push("protocol_unverified");
  if (!input.sourceHealthy) reasons.push("source_unhealthy");
  if (input.volumeUsd < input.minVolumeUsd) reasons.push("volume_below_minimum");
  if (input.uniqueTraders < input.minUniqueTraders) reasons.push("traders_below_minimum");
  if (input.liquidityUsd == null) reasons.push("liquidity_unknown");
  else if (input.liquidityUsd < input.minLiquidityUsd) reasons.push("liquidity_below_minimum");
  if (pricedCoverage < 0.8) reasons.push("price_coverage_low");

  const volumeBaseline = Math.max(input.baselineVolume1hUsd, input.baselineVolume24hUsd);
  const traderBaseline = Math.max(input.baselineUniqueTraders1h, input.baselineUniqueTraders24h);
  const volumeRatio = volumeBaseline > 0 ? input.volumeUsd / volumeBaseline : input.volumeUsd > 0 ? 3 : 0;
  const traderRatio = traderBaseline > 0 ? input.uniqueTraders / traderBaseline : input.uniqueTraders > 0 ? 3 : 0;
  const volumeAcceleration = Math.min(40, Math.max(0, (volumeRatio - 1) * 12));
  const traderAcceleration = Math.min(30, Math.max(0, (traderRatio - 1) * 10));
  const venueBreadth = Math.min(15, Math.max(0, input.venueBreadth - 1) * 7.5);
  const newPool = input.poolAgeSeconds <= 86400 ? 10 : 0;
  const liquidityDrawdown =
    input.liquidityUsd != null && input.previousLiquidityUsd != null && input.previousLiquidityUsd > 0
      ? Math.min(40, Math.max(0, 1 - input.liquidityUsd / input.previousLiquidityUsd) * 100)
      : 0;
  const dataQualityPenalty = Math.max(0, 1 - pricedCoverage) * 25;
  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        (volumeAcceleration + traderAcceleration + venueBreadth + newPool - liquidityDrawdown - dataQualityPenalty) *
          100,
      ) / 100,
    ),
  );
  if (score < (input.minTrendScore ?? 50)) reasons.push("score_below_minimum");
  return {
    input,
    state: reasons.length ? "rejected" : "qualified",
    score,
    reasons,
    components: {
      volumeAcceleration,
      traderAcceleration,
      venueBreadth,
      newPool,
      liquidityDrawdown,
      dataQualityPenalty,
    },
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

export class RobinhoodPhase1Store {
  private readonly db;

  constructor(readonly path: string) {
    this.db = openSqliteDb(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS protocol_registry (
        protocol_id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, kind TEXT NOT NULL,
        discovery_address TEXT NOT NULL, creation_topic TEXT NOT NULL, swap_topic TEXT NOT NULL,
        verified_source TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_registry (
        handle TEXT PRIMARY KEY, tier TEXT NOT NULL, category TEXT NOT NULL, canonical_url TEXT NOT NULL,
        verification_source TEXT NOT NULL, status TEXT NOT NULL, last_checked_at INTEGER, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_posts (
        post_id TEXT PRIMARY KEY, handle TEXT NOT NULL REFERENCES account_registry(handle) ON DELETE CASCADE,
        text TEXT NOT NULL, url TEXT NOT NULL, created_at TEXT NOT NULL, fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pools (
        pool_key TEXT PRIMARY KEY, execution_address TEXT NOT NULL, protocol_id TEXT NOT NULL REFERENCES protocol_registry(protocol_id),
        token0 TEXT NOT NULL, token1 TEXT NOT NULL, created_block INTEGER NOT NULL, created_at INTEGER NOT NULL,
        creation_event_id TEXT NOT NULL UNIQUE, quality TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dex_events (
        event_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL REFERENCES pools(pool_key) ON DELETE CASCADE,
        protocol_id TEXT NOT NULL, event_type TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        transaction_hash TEXT NOT NULL, log_index INTEGER NOT NULL, event_ts INTEGER NOT NULL, trader TEXT NOT NULL,
        volume_usd REAL, liquidity_usd REAL
      );
      CREATE INDEX IF NOT EXISTS dex_events_block_idx ON dex_events(block_number);
      CREATE INDEX IF NOT EXISTS dex_events_pool_ts_idx ON dex_events(pool_key,event_ts);
      CREATE TABLE IF NOT EXISTS pool_windows (
        pool_key TEXT NOT NULL REFERENCES pools(pool_key) ON DELETE CASCADE, window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL, swap_count INTEGER NOT NULL, priced_swap_count INTEGER NOT NULL,
        volume_usd REAL NOT NULL, unique_traders INTEGER NOT NULL, liquidity_usd REAL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(pool_key,window_start)
      );
      CREATE TABLE IF NOT EXISTS trend_candidates (
        pool_key TEXT NOT NULL REFERENCES pools(pool_key) ON DELETE CASCADE, window_start INTEGER NOT NULL,
        state TEXT NOT NULL, score REAL NOT NULL, reasons_json TEXT NOT NULL, components_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(pool_key,window_start)
      );
      CREATE TABLE IF NOT EXISTS signal_audit (
        audit_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL REFERENCES pools(pool_key) ON DELETE CASCADE,
        window_start INTEGER NOT NULL, state TEXT NOT NULL, score REAL NOT NULL, reason_codes_json TEXT NOT NULL,
        source_first_block INTEGER NOT NULL, source_last_block INTEGER NOT NULL, decoder_version TEXT NOT NULL,
        config_revision TEXT NOT NULL, created_at INTEGER NOT NULL, collection_lane TEXT NOT NULL DEFAULT 'legacy'
      );
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY, status TEXT NOT NULL, endpoint TEXT NOT NULL, latest_block INTEGER,
        target_block INTEGER, lag_blocks INTEGER, consecutive_failures INTEGER NOT NULL,
        last_success_at INTEGER, last_error_at INTEGER, last_error TEXT
      );
    `);
    this.ensureColumn("signal_audit", "collection_lane", "TEXT NOT NULL DEFAULT 'legacy'");
    this.seedRegistries();
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    if (columns.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private seedRegistries(): void {
    const now = Math.floor(Date.now() / 1000);
    const protocolStmt = this.db.prepare(`
      INSERT INTO protocol_registry (protocol_id,name,enabled,kind,discovery_address,creation_topic,swap_topic,verified_source,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(protocol_id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,
      kind=excluded.kind,discovery_address=excluded.discovery_address,creation_topic=excluded.creation_topic,
      swap_topic=excluded.swap_topic,verified_source=excluded.verified_source,updated_at=excluded.updated_at
    `);
    for (const protocol of BUILTIN_ROBINHOOD_PROTOCOLS) {
      protocolStmt.run(
        protocol.id,
        protocol.name,
        protocol.enabled ? 1 : 0,
        protocol.kind,
        protocol.discoveryAddress,
        protocol.creationTopic,
        protocol.swapTopic,
        protocol.verifiedSource,
        now,
      );
    }
    const accountStmt = this.db.prepare(`
      INSERT INTO account_registry (handle,tier,category,canonical_url,verification_source,status,last_checked_at,updated_at)
      VALUES (?,?,?,?,?, 'unverified', NULL, ?) ON CONFLICT(handle) DO UPDATE SET tier=excluded.tier,
      category=excluded.category,canonical_url=excluded.canonical_url,verification_source=excluded.verification_source,
      updated_at=excluded.updated_at
    `);
    for (const account of BUILTIN_ROBINHOOD_ACCOUNTS) {
      accountStmt.run(
        account.handle,
        account.tier,
        account.category,
        `https://x.com/${account.handle}`,
        account.tier === "A" ? "Robinhood public identity" : "project metadata research snapshot 2026-08-31",
        now,
      );
    }
  }

  updateAccountObservation(
    handle: string,
    status: "ok" | "no_results" | "auth_required" | "challenge" | "unknown" | "error",
    posts: Array<Record<string, unknown>>,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE account_registry SET status=?,last_checked_at=?,updated_at=? WHERE handle=?")
        .run(status, now, now, handle);
      const insert = this.db.prepare(`
        INSERT INTO account_posts (post_id,handle,text,url,created_at,fetched_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(post_id) DO UPDATE SET text=excluded.text,url=excluded.url,created_at=excluded.created_at,fetched_at=excluded.fetched_at
      `);
      for (const post of posts) {
        const id = String(post.id ?? "").trim();
        if (!/^\d+$/.test(id)) continue;
        insert.run(
          id,
          handle,
          String(post.text ?? "").slice(0, 4000),
          String(post.url ?? "").slice(0, 1000),
          String(post.created_at ?? "").slice(0, 100),
          now,
        );
      }
      this.db.prepare("DELETE FROM account_posts WHERE fetched_at < ?").run(now - 7 * 86400);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  ensureConfiguredAccount(handle: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(`
      INSERT INTO account_registry (handle,tier,category,canonical_url,verification_source,status,last_checked_at,updated_at)
      VALUES (?, 'custom', 'configured', ?, 'user configuration; identity unverified', 'unverified', NULL, ?)
      ON CONFLICT(handle) DO NOTHING
    `)
      .run(handle, `https://x.com/${handle}`, now);
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM collector_state WHERE key=?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO collector_state (key,value,updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
      )
      .run(key, value, Math.floor(Date.now() / 1000));
  }

  getPools(protocolId?: string): DiscoveredPool[] {
    const rows = (
      protocolId
        ? this.db.prepare("SELECT * FROM pools WHERE protocol_id=? ORDER BY created_block").all(protocolId)
        : this.db.prepare("SELECT * FROM pools ORDER BY created_block").all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      poolKey: String(row.pool_key),
      executionAddress: String(row.execution_address),
      protocolId: String(row.protocol_id),
      token0: String(row.token0),
      token1: String(row.token1),
      createdBlock: Number(row.created_block),
      createdAt: Number(row.created_at),
      creationEventId: String(row.creation_event_id),
      quality: "verified",
    }));
  }

  count(table: "pools" | "dex_events" | "pool_windows" | "trend_candidates" | "signal_audit"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number };
    return Number(row.count ?? 0);
  }

  getCandidate(poolKey: string, windowStart: number): { state: string; evidence: TrendInput } | null {
    const row = this.db
      .prepare("SELECT state,evidence_json FROM trend_candidates WHERE pool_key=? AND window_start=?")
      .get(poolKey, windowStart) as { state?: string; evidence_json?: string } | undefined;
    return row
      ? {
          state: String(row.state),
          evidence: JSON.parse(String(row.evidence_json)) as TrendInput,
        }
      : null;
  }

  hasAudit(poolKey: string, windowStart: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM signal_audit WHERE pool_key=? AND window_start=?").get(poolKey, windowStart),
    );
  }

  getAuditLane(poolKey: string, windowStart: number): string | null {
    const row = this.db
      .prepare("SELECT collection_lane FROM signal_audit WHERE pool_key=? AND window_start=?")
      .get(poolKey, windowStart) as { collection_lane?: string } | undefined;
    return row?.collection_lane ?? null;
  }

  getWindow(poolKey: string, windowStart: number): { volumeUsd: number; swapCount: number } | null {
    const row = this.db
      .prepare("SELECT volume_usd,swap_count FROM pool_windows WHERE pool_key=? AND window_start=?")
      .get(poolKey, windowStart) as { volume_usd?: number; swap_count?: number } | undefined;
    return row ? { volumeUsd: Number(row.volume_usd ?? 0), swapCount: Number(row.swap_count ?? 0) } : null;
  }

  getHealthStatus(source = "robinhood_chain_phase1"): string | null {
    const row = this.db.prepare("SELECT status FROM source_health WHERE source=?").get(source) as
      | { status?: string }
      | undefined;
    return row?.status ?? null;
  }

  updateHealth(input: {
    source?: string;
    status: "ok" | "error";
    endpoint?: string;
    latestBlock?: number;
    targetBlock?: number;
    lagBlocks?: number;
    error?: string;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    const source = input.source ?? "robinhood_chain_phase1";
    const current = this.db.prepare("SELECT consecutive_failures FROM source_health WHERE source=?").get(source) as
      | { consecutive_failures?: number }
      | undefined;
    const failures = input.status === "ok" ? 0 : Number(current?.consecutive_failures ?? 0) + 1;
    this.db
      .prepare(`
      INSERT INTO source_health (source,status,endpoint,latest_block,target_block,lag_blocks,consecutive_failures,last_success_at,last_error_at,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET status=excluded.status,endpoint=excluded.endpoint,latest_block=excluded.latest_block,
      target_block=excluded.target_block,lag_blocks=excluded.lag_blocks,consecutive_failures=excluded.consecutive_failures,
      last_success_at=CASE WHEN excluded.status='ok' THEN excluded.last_success_at ELSE source_health.last_success_at END,
      last_error_at=CASE WHEN excluded.status='ok' THEN source_health.last_error_at ELSE excluded.last_error_at END,
      last_error=CASE WHEN excluded.status='ok' THEN NULL ELSE excluded.last_error END
    `)
      .run(
        source,
        input.status,
        input.endpoint ? sanitizeRpcUrl(input.endpoint) : "",
        input.latestBlock ?? null,
        input.targetBlock ?? null,
        input.lagBlocks ?? null,
        failures,
        input.status === "ok" ? now : null,
        input.status === "ok" ? null : now,
        input.error?.slice(0, 500) ?? null,
      );
  }

  markQualifiedCandidatesStale(reason: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(`
      UPDATE trend_candidates SET state='stale',reasons_json=?,updated_at=? WHERE state='qualified'
    `)
      .run(JSON.stringify([reason.slice(0, 200)]), now);
  }

  applyBatch(input: {
    firstBlock: number;
    lastBlock: number;
    pools: DiscoveredPool[];
    events: NormalizedDexEvent[];
    retentionDays: number;
    cursor?: number;
    lane?: "legacy" | "realtime" | "backfill";
    stateUpdates?: Record<string, string>;
    thresholds?: Pick<
      RobinhoodPhase1Config,
      "minLiquidityUsd" | "minVolume5mUsd" | "minUniqueTraders" | "minTrendScore"
    >;
  }): { qualified: number } {
    const now = Math.floor(Date.now() / 1000);
    const thresholds = input.thresholds ?? {
      minLiquidityUsd: 25_000,
      minVolume5mUsd: 10_000,
      minUniqueTraders: 3,
      minTrendScore: 50,
    };
    const affected = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const oldRows = this.db
        .prepare("SELECT pool_key,event_ts FROM dex_events WHERE block_number BETWEEN ? AND ?")
        .all(input.firstBlock, input.lastBlock) as Array<{ pool_key: string; event_ts: number }>;
      for (const row of oldRows) affected.add(`${row.pool_key}:${Math.floor(row.event_ts / 300) * 300}`);
      this.db
        .prepare("DELETE FROM dex_events WHERE block_number BETWEEN ? AND ?")
        .run(input.firstBlock, input.lastBlock);
      if (input.lane !== "backfill") {
        this.db.prepare("DELETE FROM pools WHERE created_block BETWEEN ? AND ?").run(input.firstBlock, input.lastBlock);
      }

      const poolStmt = this.db.prepare(`
        INSERT INTO pools (pool_key,execution_address,protocol_id,token0,token1,created_block,created_at,creation_event_id,quality)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(pool_key) DO UPDATE SET execution_address=excluded.execution_address,
        protocol_id=excluded.protocol_id,token0=excluded.token0,token1=excluded.token1,created_block=excluded.created_block,
        created_at=excluded.created_at,creation_event_id=excluded.creation_event_id,quality=excluded.quality
      `);
      for (const pool of input.pools) {
        poolStmt.run(
          pool.poolKey,
          pool.executionAddress,
          pool.protocolId,
          pool.token0,
          pool.token1,
          pool.createdBlock,
          pool.createdAt,
          pool.creationEventId,
          pool.quality,
        );
      }
      const eventStmt = this.db.prepare(`
        INSERT INTO dex_events (event_id,pool_key,protocol_id,event_type,block_number,block_hash,transaction_hash,log_index,event_ts,trader,volume_usd,liquidity_usd)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const event of input.events) {
        eventStmt.run(
          event.eventId,
          event.poolKey,
          event.protocolId,
          event.eventType,
          event.blockNumber,
          event.blockHash,
          event.transactionHash,
          event.logIndex,
          event.timestamp,
          event.trader,
          event.volumeUsd,
          event.liquidityUsd,
        );
        affected.add(`${event.poolKey}:${Math.floor(event.timestamp / 300) * 300}`);
      }

      const observedTimestamps = [
        ...input.events.map((event) => event.timestamp),
        ...input.pools.map((pool) => pool.createdAt),
      ];
      const latestTs = observedTimestamps.length ? Math.max(...observedTimestamps) : now;
      const cutoff = latestTs - input.retentionDays * 86400;
      const rejectedCutoff = latestTs - Math.min(input.retentionDays, 7) * 86400;
      this.db.prepare("DELETE FROM dex_events WHERE event_ts < ?").run(cutoff);
      this.db.prepare("DELETE FROM pool_windows WHERE window_end <= ?").run(cutoff);
      this.db
        .prepare("DELETE FROM trend_candidates WHERE window_start < ? OR (state='rejected' AND window_start < ?)")
        .run(cutoff, rejectedCutoff);
      this.db.prepare("DELETE FROM signal_audit WHERE window_start < ?").run(cutoff);

      let qualified = 0;
      const realtimeStartBlock = stateNumber(this.getState("realtime_start_block"));
      for (const key of affected) {
        const separator = key.lastIndexOf(":");
        const poolKey = key.slice(0, separator);
        const start = Number(key.slice(separator + 1));
        this.db.prepare("DELETE FROM pool_windows WHERE pool_key=? AND window_start=?").run(poolKey, start);
        this.db.prepare("DELETE FROM trend_candidates WHERE pool_key=? AND window_start=?").run(poolKey, start);
        this.db.prepare("DELETE FROM signal_audit WHERE pool_key=? AND window_start=?").run(poolKey, start);
        const aggregate = this.db
          .prepare(`
          SELECT COUNT(*) AS swap_count, COUNT(volume_usd) AS priced_swap_count, COALESCE(SUM(volume_usd),0) AS volume_usd,
                 COUNT(DISTINCT trader) AS unique_traders
          FROM dex_events WHERE pool_key=? AND event_ts>=? AND event_ts<?
        `)
          .get(poolKey, start, start + 300) as Record<string, number>;
        const swapCount = Number(aggregate.swap_count ?? 0);
        if (!swapCount) continue;
        const liquidityRow = this.db
          .prepare(`
          SELECT liquidity_usd FROM dex_events WHERE pool_key=? AND event_ts>=? AND event_ts<? AND liquidity_usd IS NOT NULL
          ORDER BY event_ts DESC,log_index DESC LIMIT 1
        `)
          .get(poolKey, start, start + 300) as { liquidity_usd?: number } | undefined;
        const liquidityUsd = liquidityRow?.liquidity_usd == null ? null : Number(liquidityRow.liquidity_usd);
        const containsRealtimeEvent =
          input.lane === "backfill" && realtimeStartBlock != null
            ? Boolean(
                this.db
                  .prepare(
                    "SELECT 1 FROM dex_events WHERE pool_key=? AND event_ts>=? AND event_ts<? AND block_number>=? LIMIT 1",
                  )
                  .get(poolKey, start, start + 300, realtimeStartBlock),
              )
            : false;
        const collectionLane = containsRealtimeEvent ? "realtime" : (input.lane ?? "legacy");
        this.db
          .prepare(`
          INSERT INTO pool_windows (pool_key,window_start,window_end,swap_count,priced_swap_count,volume_usd,unique_traders,liquidity_usd,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
        `)
          .run(
            poolKey,
            start,
            start + 300,
            swapCount,
            Number(aggregate.priced_swap_count ?? 0),
            Number(aggregate.volume_usd ?? 0),
            Number(aggregate.unique_traders ?? 0),
            liquidityUsd,
            now,
          );
        const pool = this.db.prepare("SELECT * FROM pools WHERE pool_key=?").get(poolKey) as Record<string, unknown>;
        const history = this.db
          .prepare(`
          SELECT window_start,volume_usd,unique_traders,liquidity_usd FROM pool_windows
          WHERE pool_key=? AND window_start>=? AND window_start<? ORDER BY window_start DESC
        `)
          .all(poolKey, start - 86400, start) as Array<{
          window_start: number;
          volume_usd: number;
          unique_traders: number;
          liquidity_usd?: number | null;
        }>;
        const asset =
          String(pool.token0) === USDG || String(pool.token0) === USDE ? String(pool.token1) : String(pool.token0);
        const history1h = history.filter((row) => Number(row.window_start) >= start - 3600);
        const breadth = this.db
          .prepare(`
          SELECT COUNT(DISTINCT p.protocol_id) AS count FROM pools p
          JOIN dex_events e ON e.pool_key=p.pool_key
          WHERE (p.token0=? OR p.token1=?) AND e.event_ts>=? AND e.event_ts<?
        `)
          .get(asset, asset, start - 3300, start + 300) as { count?: number };
        const evaluation = evaluateTrendCandidate({
          volumeUsd: Number(aggregate.volume_usd ?? 0),
          baselineVolume1hUsd: median(history1h.map((row) => Number(row.volume_usd))),
          baselineVolume24hUsd: median(history.map((row) => Number(row.volume_usd))),
          uniqueTraders: Number(aggregate.unique_traders ?? 0),
          baselineUniqueTraders1h: median(history1h.map((row) => Number(row.unique_traders))),
          baselineUniqueTraders24h: median(history.map((row) => Number(row.unique_traders))),
          liquidityUsd,
          previousLiquidityUsd: history.find((row) => row.liquidity_usd != null)?.liquidity_usd ?? null,
          venueBreadth: Number(breadth.count ?? 1),
          poolAgeSeconds: Math.max(0, start + 300 - Number(pool.created_at)),
          pricedSwapCount: Number(aggregate.priced_swap_count ?? 0),
          swapCount,
          verifiedProtocol: String(pool.quality) === "verified",
          sourceHealthy: true,
          minVolumeUsd: thresholds.minVolume5mUsd,
          minLiquidityUsd: thresholds.minLiquidityUsd,
          minUniqueTraders: thresholds.minUniqueTraders,
          minTrendScore: thresholds.minTrendScore,
        });
        if (evaluation.state === "qualified") qualified += 1;
        this.db
          .prepare(`
          INSERT INTO signal_audit (audit_id,pool_key,window_start,state,score,reason_codes_json,source_first_block,source_last_block,decoder_version,config_revision,created_at,collection_lane)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `)
          .run(
            `${poolKey}:${start}:phase1-v1`,
            poolKey,
            start,
            evaluation.state,
            evaluation.score,
            JSON.stringify(evaluation.reasons),
            input.firstBlock,
            input.lastBlock,
            "phase1-v1",
            "approved-2026-08-31-capacity-1000",
            now,
            collectionLane,
          );
        this.db
          .prepare(`
          INSERT INTO trend_candidates (pool_key,window_start,state,score,reasons_json,components_json,evidence_json,updated_at)
          VALUES (?,?,?,?,?,?,?,?)
        `)
          .run(
            poolKey,
            start,
            evaluation.state,
            evaluation.score,
            JSON.stringify(evaluation.reasons),
            JSON.stringify(evaluation.components),
            JSON.stringify(evaluation.input),
            now,
          );
      }
      const lane = input.lane ?? "legacy";
      const cursorKey = lane === "realtime" ? "realtime_cursor" : "last_confirmed_block";
      const previousState = this.getState(cursorKey);
      const previousCursor = previousState == null ? -1 : Number(previousState);
      const cursor = Math.max(
        Number.isSafeInteger(previousCursor) ? previousCursor : -1,
        input.cursor ?? input.lastBlock,
      );
      const states = {
        ...(lane === "realtime"
          ? { realtime_cursor: String(cursor) }
          : lane === "backfill"
            ? { backfill_cursor: String(cursor), last_confirmed_block: String(cursor) }
            : { last_confirmed_block: String(cursor) }),
        ...(input.stateUpdates ?? {}),
      };
      const stateStmt = this.db.prepare(`
        INSERT INTO collector_state (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
      `);
      for (const [key, value] of Object.entries(states)) stateStmt.run(key, value, now);
      this.db.exec("COMMIT");
      return { qualified };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    closeSqliteDb(this.path);
  }
}

function xFailureStatus(message: string): "auth_required" | "challenge" | "unknown" | "error" {
  const value = message.toLowerCase();
  if (value.includes("auth-required") || value.includes("login required")) return "auth_required";
  if (value.includes("challenge") || value.includes("captcha")) return "challenge";
  if (value.includes("unknown")) return "unknown";
  return "error";
}

export async function collectRobinhoodPhase1Accounts(options: {
  config: TradeConfig;
  dbPath?: string;
  force?: boolean;
  fetcher?: (handle: string, limit: number) => Promise<Array<Record<string, unknown>>>;
}): Promise<RobinhoodPhase1XResult> {
  const cfg = resolveRobinhoodPhase1Config(options.config);
  if ((!cfg.enabled || !cfg.xEnabled) && !options.force) {
    return { status: "disabled", accountsChecked: 0, postsObserved: 0, health: {} };
  }
  const dbPath = options.dbPath ?? ROBINHOOD_CHAIN_PHASE1_DB_PATH;
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new RobinhoodPhase1Store(dbPath);
  const fetcher =
    options.fetcher ?? ((handle, limit) => fetchTweets(handle, limit, undefined, ROBINHOOD_X_BROWSER_SESSION));
  const health: Record<string, number> = {};
  let postsObserved = 0;
  const accounts = cfg.xAccounts.slice(0, cfg.xMaxAccounts);
  for (const handle of accounts) {
    store.ensureConfiguredAccount(handle);
    try {
      const posts = await fetcher(handle, cfg.xFetchLimit);
      const status = posts.length ? "ok" : "no_results";
      store.updateAccountObservation(handle, status, posts);
      health[status] = (health[status] ?? 0) + 1;
      postsObserved += posts.length;
    } catch (error) {
      const status = xFailureStatus(error instanceof Error ? error.message : String(error));
      store.updateAccountObservation(handle, status, []);
      health[status] = (health[status] ?? 0) + 1;
    }
  }
  return { status: "persisted", accountsChecked: accounts.length, postsObserved, health };
}

class RpcHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number | null,
  ) {
    super(`HTTP ${status}`);
  }
}

function parseRetryAfterMs(response: Response): number | null {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, Math.round(seconds * 1000));
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.min(30_000, Math.max(0, retryAt - Date.now())) : null;
}

function defaultTransport(timeoutMs: number): RpcTransport {
  return async (url, method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new RpcHttpError(response.status, parseRetryAfterMs(response));
    const body = (await response.json()) as Record<string, unknown>;
    if (body.error && typeof body.error === "object") {
      throw new Error(String((body.error as Record<string, unknown>).message ?? "JSON-RPC error").slice(0, 300));
    }
    return body.result;
  };
}

function sanitizeErrorText(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => sanitizeRpcUrl(value));
}

async function rpcCall(
  urls: string[],
  transport: RpcTransport,
  method: string,
  params: unknown[],
  options: {
    maxAttempts?: number;
    retryBaseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ value: unknown; endpoint: string }> {
  const errors: string[] = [];
  const maxAttempts = Math.min(3, Math.max(1, Math.trunc(options.maxAttempts ?? 3)));
  const retryBaseMs = Math.min(5000, Math.max(100, Math.trunc(options.retryBaseMs ?? 1000)));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let retryable = false;
    let retryAfterMs = 0;
    for (const url of urls) {
      try {
        return { value: await transport(url, method, params), endpoint: sanitizeRpcUrl(url) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${sanitizeRpcUrl(url)}: ${sanitizeErrorText(message).slice(0, 200)}`);
        const status = error instanceof RpcHttpError ? error.status : Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
        retryable ||=
          status === 403 ||
          status === 408 ||
          status === 425 ||
          status === 429 ||
          status >= 500 ||
          /timeout|timed out|fetch failed|connection|socket|network/i.test(message);
        if (error instanceof RpcHttpError && error.retryAfterMs != null) {
          retryAfterMs = Math.max(retryAfterMs, error.retryAfterMs);
        }
      }
    }
    if (!retryable || attempt + 1 >= maxAttempts) break;
    await sleep(Math.max(retryAfterMs, Math.min(5000, retryBaseMs * 2 ** attempt)));
  }
  throw new Error(`${method} failed on all RPC endpoints: ${errors.join("; ")}`);
}

async function fetchRpcLogs(
  urls: string[],
  transport: RpcTransport,
  filter: Record<string, unknown>,
  maxBlocksPerRequest: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<Phase1RpcLog[]> {
  const fromBlock = parseHexNumber(filter.fromBlock, "log from block");
  const toBlock = parseHexNumber(filter.toBlock, "log to block");
  if (toBlock < fromBlock) throw new Error("invalid RPC log block range");
  const logs = new Map<string, Phase1RpcLog>();
  for (let first = fromBlock; first <= toBlock; first += maxBlocksPerRequest) {
    const last = Math.min(toBlock, first + maxBlocksPerRequest - 1);
    const response = await rpcCall(
      urls,
      transport,
      "eth_getLogs",
      [
        {
          ...filter,
          fromBlock: `0x${first.toString(16)}`,
          toBlock: `0x${last.toString(16)}`,
        },
      ],
      { maxAttempts: 3, sleep },
    );
    for (const item of parseLogs(response.value).filter((row) => !row.removed)) logs.set(eventId(item), item);
  }
  return [...logs.values()];
}

async function verifyRpcAndProtocols(
  urls: string[],
  transport: RpcTransport,
  sleep?: (ms: number) => Promise<void>,
): Promise<string[]> {
  const valid: string[] = [];
  const observed: number[] = [];
  for (const url of urls) {
    try {
      const chainId = parseHexNumber((await rpcCall([url], transport, "eth_chainId", [], { sleep })).value, "chain id");
      observed.push(chainId);
      if (chainId === ROBINHOOD_CHAIN_ID) valid.push(url);
    } catch {
      // The caller receives a bounded aggregate failure if no endpoint validates.
    }
  }
  if (!valid.length) {
    if (observed.length && observed.every((value) => value !== ROBINHOOD_CHAIN_ID)) throw new WrongChainError(observed);
    throw new Error("unable to validate Robinhood Chain Phase 1 RPC");
  }
  const verified: string[] = [];
  for (const url of valid) {
    try {
      for (const protocol of BUILTIN_ROBINHOOD_PROTOCOLS.filter((item) => item.enabled)) {
        const code = String(
          (await rpcCall([url], transport, "eth_getCode", [protocol.discoveryAddress, "latest"], { sleep })).value,
        );
        if (!/^0x[0-9a-f]+$/i.test(code) || code === "0x") throw new Error(`${protocol.id} bytecode missing`);
      }
      verified.push(url);
    } catch {
      // Try the next already chain-validated endpoint.
    }
  }
  if (!verified.length) throw new Error("Robinhood Chain Phase 1 protocol bytecode validation failed");
  return verified;
}

function parseLogs(value: unknown): Phase1RpcLog[] {
  if (!Array.isArray(value)) throw new Error("RPC returned invalid logs");
  return value.filter((row): row is Phase1RpcLog => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

async function mapConcurrent<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await worker(items[index]!);
      }
    }),
  );
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function fetchBlockTimestamps(
  blockNumbers: number[],
  urls: string[],
  transport: RpcTransport,
  concurrency: number,
  sleep?: (ms: number) => Promise<void>,
): Promise<Map<number, number>> {
  const unique = [...new Set(blockNumbers)].sort((a, b) => a - b);
  const rows = await mapConcurrent(unique, concurrency, async (number) => {
    const response = await rpcCall(urls, transport, "eth_getBlockByNumber", [`0x${number.toString(16)}`, false], {
      sleep,
    });
    const block = response.value as Record<string, unknown>;
    if (parseHexNumber(block.number, "block number") !== number) throw new Error(`RPC returned wrong block ${number}`);
    return [number, parseHexNumber(block.timestamp, "block timestamp")] as const;
  });
  return new Map(rows);
}

function parseV2LiquidityUsd(result: unknown, pool: DiscoveredPool): number | null {
  const dataWords = words(String(result ?? "0x"));
  if (dataWords.length < 2) return null;
  const decimals0 = STABLECOIN_DECIMALS.get(pool.token0);
  const decimals1 = STABLECOIN_DECIMALS.get(pool.token1);
  if (decimals0 != null) return decimalAmount(unsignedWord(dataWords[0]!), decimals0) * 2;
  if (decimals1 != null) return decimalAmount(unsignedWord(dataWords[1]!), decimals1) * 2;
  return null;
}

function stablecoinForPool(pool: DiscoveredPool): { address: string; decimals: number } | null {
  const decimals0 = STABLECOIN_DECIMALS.get(pool.token0);
  if (decimals0 != null) return { address: pool.token0, decimals: decimals0 };
  const decimals1 = STABLECOIN_DECIMALS.get(pool.token1);
  if (decimals1 != null) return { address: pool.token1, decimals: decimals1 };
  return null;
}

function balanceOfCallData(address: string): string {
  return `${BALANCE_OF_SELECTOR}${address.slice(2).padStart(64, "0")}`;
}

function parseStableBalanceLiquidity(result: unknown, decimals: number): number | null {
  const dataWords = words(String(result ?? "0x"));
  if (!dataWords.length) return null;
  return decimalAmount(unsignedWord(dataWords[0]!), decimals) * 2;
}

async function collectPhase1Range(input: {
  store: RobinhoodPhase1Store;
  cfg: RobinhoodPhase1Config;
  urls: string[];
  transport: RpcTransport;
  firstBlock: number;
  lastBlock: number;
  targetBlock: number;
  bootstrapDiscovery: boolean;
  lane: "realtime" | "backfill";
  cursor: number;
  stateUpdates: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ poolsDiscovered: number; swapsObserved: number; candidatesQualified: number }> {
  const { store, cfg, urls, transport, firstBlock, lastBlock, targetBlock } = input;
  const range = { fromBlock: `0x${firstBlock.toString(16)}`, toBlock: `0x${lastBlock.toString(16)}` };
  const discoveryFirstBlock = input.bootstrapDiscovery
    ? Math.max(0, targetBlock - cfg.stablePoolDiscoveryBackfillBlocks + 1)
    : firstBlock;
  const discoveryRange = {
    fromBlock: `0x${discoveryFirstBlock.toString(16)}`,
    toBlock: `0x${targetBlock.toString(16)}`,
  };
  const enabledProtocols = BUILTIN_ROBINHOOD_PROTOCOLS.filter((item) => item.enabled);
  const currentCreationLogs = await fetchRpcLogs(
    urls,
    transport,
    {
      ...range,
      address: enabledProtocols.map((protocol) => protocol.discoveryAddress),
      topics: [enabledProtocols.map((protocol) => protocol.creationTopic)],
    },
    cfg.maxLogBlocksPerRequest,
    input.sleep,
  );
  const currentCreationGroups = enabledProtocols.map((protocol) => ({
    protocol,
    logs: currentCreationLogs.filter(
      (item) =>
        item.address.toLowerCase() === protocol.discoveryAddress &&
        String(item.topics[0] ?? "").toLowerCase() === protocol.creationTopic,
    ),
  }));
  if (currentCreationGroups.reduce((count, group) => count + group.logs.length, 0) !== currentCreationLogs.length) {
    throw new Error("pool creation log does not match an enabled protocol");
  }
  const stableTopics = [...STABLECOIN_DECIMALS.keys()].map(addressTopic);
  const bootstrapGroups = input.bootstrapDiscovery
    ? await mapConcurrent(
        enabledProtocols.filter((protocol) => protocol.kind !== "v4"),
        cfg.logRpcConcurrency,
        async (protocol) => {
          const positions = protocol.kind === "metric" ? [2, 3] : [1, 2];
          const logs = new Map<string, Phase1RpcLog>();
          for (const position of positions) {
            const topics: Array<string | string[] | null> = [protocol.creationTopic];
            while (topics.length <= position) topics.push(null);
            topics[position] = stableTopics;
            const rows = await fetchRpcLogs(
              urls,
              transport,
              { ...discoveryRange, address: protocol.discoveryAddress, topics },
              cfg.maxLogBlocksPerRequest,
              input.sleep,
            );
            for (const item of rows) logs.set(eventId(item), item);
          }
          return { protocol, logs: [...logs.values()] };
        },
      )
    : [];
  const creationGroups = enabledProtocols.map((protocol) => {
    const logs = new Map<string, Phase1RpcLog>();
    for (const group of [...currentCreationGroups, ...bootstrapGroups]) {
      if (group.protocol.id !== protocol.id) continue;
      for (const item of group.logs) logs.set(eventId(item), item);
    }
    return { protocol, logs: [...logs.values()] };
  });
  const creationLogs = creationGroups.flatMap((group) => group.logs);
  const timestampBlocks = creationLogs.map((item) => parseHexNumber(item.blockNumber, "block number"));
  let timestamps = await fetchBlockTimestamps(timestampBlocks, urls, transport, cfg.logRpcConcurrency, input.sleep);
  const discovered = creationGroups.flatMap(({ protocol, logs }) =>
    logs.map((item) =>
      decodePoolCreatedLog(protocol, item, timestamps.get(parseHexNumber(item.blockNumber, "block number"))!),
    ),
  );
  const poolMap = new Map(store.getPools().map((pool) => [pool.poolKey, pool]));
  for (const pool of discovered) poolMap.set(pool.poolKey, pool);
  type SwapGroup = { protocol: RobinhoodProtocolDefinition; pools: DiscoveredPool[]; logs: Phase1RpcLog[] };
  type SwapTask =
    | { kind: "v4"; protocol: RobinhoodProtocolDefinition; pools: DiscoveredPool[] }
    | { kind: "non_v4"; pools: DiscoveredPool[] };
  const protocolById = new Map(enabledProtocols.map((protocol) => [protocol.id, protocol]));
  const stablePools = [...poolMap.values()].filter((pool) => stablecoinForPool(pool) !== null);
  const swapTasks: SwapTask[] = [];
  for (const protocol of enabledProtocols.filter((item) => item.kind === "v4")) {
    const pools = stablePools.filter((pool) => pool.protocolId === protocol.id);
    if (pools.length > 0) swapTasks.push({ kind: "v4", protocol, pools });
  }
  for (const pools of chunk(
    stablePools.filter((pool) => protocolById.get(pool.protocolId)?.kind !== "v4"),
    50,
  )) {
    swapTasks.push({ kind: "non_v4", pools });
  }
  const swapGroups = (
    await mapConcurrent(swapTasks, cfg.logRpcConcurrency, async (task): Promise<SwapGroup[]> => {
      if (task.kind === "v4") {
        const logs = await fetchRpcLogs(
          urls,
          transport,
          {
            ...range,
            address: task.protocol.discoveryAddress,
            topics: [task.protocol.swapTopic],
          },
          cfg.maxLogBlocksPerRequest,
          input.sleep,
        );
        const stablePoolKeys = new Set(task.pools.map((pool) => pool.poolKey));
        const filteredLogs = logs.filter((item) => {
          if (
            item.address.toLowerCase() !== task.protocol.discoveryAddress ||
            String(item.topics[0] ?? "").toLowerCase() !== task.protocol.swapTopic
          ) {
            throw new Error("V4 swap log does not match the requested PoolManager and topic");
          }
          const poolKey = String(item.topics[1] ?? "").toLowerCase();
          if (!/^0x[0-9a-f]{64}$/.test(poolKey)) throw new Error("V4 swap log contains an invalid pool key");
          const pool = poolMap.get(poolKey);
          if (!pool) return false;
          if (pool.protocolId !== task.protocol.id || pool.executionAddress !== task.protocol.discoveryAddress) {
            throw new Error(`${task.protocol.id} swap references an invalid pool identity`);
          }
          return stablePoolKeys.has(poolKey);
        });
        return [{ protocol: task.protocol, pools: task.pools, logs: filteredLogs }];
      }
      const poolByExecution = new Map(task.pools.map((pool) => [pool.executionAddress, pool]));
      if (poolByExecution.size !== task.pools.length) throw new Error("duplicate swap execution address");
      const protocols = [
        ...new Map(
          task.pools.map((pool) => {
            const protocol = protocolById.get(pool.protocolId);
            if (!protocol || protocol.kind === "v4") throw new Error("stable pool references an invalid protocol");
            return [protocol.id, protocol] as const;
          }),
        ).values(),
      ];
      const logs = await fetchRpcLogs(
        urls,
        transport,
        {
          ...range,
          address: task.pools.map((pool) => pool.executionAddress),
          topics: [protocols.map((protocol) => protocol.swapTopic)],
        },
        cfg.maxLogBlocksPerRequest,
        input.sleep,
      );
      const groups = new Map<string, SwapGroup>();
      for (const pool of task.pools) {
        const protocol = protocolById.get(pool.protocolId)!;
        const group = groups.get(protocol.id) ?? { protocol, pools: [], logs: [] };
        group.pools.push(pool);
        groups.set(protocol.id, group);
      }
      for (const item of logs) {
        const pool = poolByExecution.get(item.address.toLowerCase());
        const protocol = pool ? protocolById.get(pool.protocolId) : undefined;
        if (!pool || !protocol || String(item.topics[0] ?? "").toLowerCase() !== protocol.swapTopic) {
          throw new Error("swap log does not match a requested pool and protocol");
        }
        groups.get(protocol.id)!.logs.push(item);
      }
      return [...groups.values()];
    })
  ).flat();
  const swapLogs = swapGroups.flatMap((group) => group.logs);
  timestamps = await fetchBlockTimestamps(
    [...timestampBlocks, ...swapLogs.map((item) => parseHexNumber(item.blockNumber, "block number"))],
    urls,
    transport,
    cfg.logRpcConcurrency,
    input.sleep,
  );
  const liquidityByPool = new Map<string, number | null>();
  const activePoolKeys = new Set<string>();
  for (const { protocol, pools, logs } of swapGroups) {
    const byExecution = new Map(pools.map((pool) => [pool.executionAddress, pool.poolKey]));
    for (const item of logs) {
      const key =
        protocol.kind === "v4"
          ? String(item.topics[1] ?? "").toLowerCase()
          : byExecution.get(item.address.toLowerCase());
      if (key) activePoolKeys.add(key);
    }
  }
  const activePools = [...poolMap.values()].filter((pool) => activePoolKeys.has(pool.poolKey));
  await mapConcurrent(activePools, cfg.logRpcConcurrency, async (pool) => {
    try {
      const protocol = enabledProtocols.find((item) => item.id === pool.protocolId)!;
      if (protocol.kind === "v4") {
        liquidityByPool.set(pool.poolKey, null);
        return;
      }
      if (protocol.kind === "v2") {
        const response = await rpcCall(
          urls,
          transport,
          "eth_call",
          [{ to: pool.executionAddress, data: GET_RESERVES_SELECTOR }, `0x${lastBlock.toString(16)}`],
          { sleep: input.sleep },
        );
        liquidityByPool.set(pool.poolKey, parseV2LiquidityUsd(response.value, pool));
        return;
      }
      const stablecoin = stablecoinForPool(pool);
      if (!stablecoin) {
        liquidityByPool.set(pool.poolKey, null);
        return;
      }
      const response = await rpcCall(
        urls,
        transport,
        "eth_call",
        [{ to: stablecoin.address, data: balanceOfCallData(pool.executionAddress) }, `0x${lastBlock.toString(16)}`],
        { sleep: input.sleep },
      );
      liquidityByPool.set(pool.poolKey, parseStableBalanceLiquidity(response.value, stablecoin.decimals));
    } catch {
      liquidityByPool.set(pool.poolKey, null);
    }
  });
  const events: NormalizedDexEvent[] = [];
  for (const { protocol, pools, logs } of swapGroups) {
    const poolsByExecution = new Map(pools.map((pool) => [pool.executionAddress, pool]));
    const poolsByKey = new Map(pools.map((pool) => [pool.poolKey, pool]));
    for (const item of logs) {
      const pool =
        protocol.kind === "v4"
          ? poolsByKey.get(String(item.topics[1] ?? "").toLowerCase())
          : poolsByExecution.get(String(item.address).toLowerCase());
      if (!pool) throw new Error(`${protocol.id} swap references an unknown pool`);
      const blockNumber = parseHexNumber(item.blockNumber, "block number");
      events.push(
        decodeSwapLog(
          protocol,
          pool,
          item,
          timestamps.get(blockNumber)!,
          STABLECOIN_DECIMALS,
          liquidityByPool.get(pool.poolKey) ?? null,
        ),
      );
    }
  }
  const applied = store.applyBatch({
    firstBlock,
    lastBlock,
    pools: discovered,
    events,
    retentionDays: cfg.retentionDays,
    cursor: input.cursor,
    thresholds: cfg,
    lane: input.lane,
    stateUpdates: {
      ...input.stateUpdates,
      ...(input.bootstrapDiscovery ? { pool_discovery_bootstrap_v1: "1" } : {}),
    },
  });
  return {
    poolsDiscovered: discovered.length,
    swapsObserved: events.length,
    candidatesQualified: applied.qualified,
  };
}

export async function collectRobinhoodPhase1(options: {
  config: TradeConfig;
  dbPath?: string;
  transport?: RpcTransport;
  force?: boolean;
  allowRealtimeRebase?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RobinhoodPhase1Result> {
  const phase0 = resolveRobinhoodChainConfig(options.config);
  const cfg = resolveRobinhoodPhase1Config(options.config);
  if ((!phase0.enabled || !cfg.enabled) && !options.force) return { status: "disabled", delivery: "shadow" };
  if (!Number.isInteger(phase0.chainId) || phase0.chainId !== ROBINHOOD_CHAIN_ID)
    throw new WrongChainError([phase0.chainId]);
  const dbPath = options.dbPath ?? ROBINHOOD_CHAIN_PHASE1_DB_PATH;
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new RobinhoodPhase1Store(dbPath);
  const transport = options.transport ?? defaultTransport(phase0.requestTimeoutMs);
  let latestBlock: number | undefined;
  let targetBlock: number | undefined;
  try {
    const urls = await verifyRpcAndProtocols(cfg.rpcUrls, transport, options.sleep);
    const latest = await rpcCall(urls, transport, "eth_blockNumber", [], { sleep: options.sleep });
    latestBlock = parseHexNumber(latest.value, "latest block");
    targetBlock = latestBlock - phase0.confirmations;
    const legacyCursor = stateNumber(store.getState("last_confirmed_block"));
    const previousRealtimeCursor = stateNumber(store.getState("realtime_cursor"));
    const persistedRealtimeStart = stateNumber(store.getState("realtime_start_block"));
    if (targetBlock < 0) {
      store.updateHealth({ status: "ok", endpoint: latest.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return { status: "idle", delivery: "shadow", endpoint: latest.endpoint, latestBlock, targetBlock };
    }
    if (previousRealtimeCursor != null && targetBlock < previousRealtimeCursor) {
      store.updateHealth({ status: "ok", endpoint: latest.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return {
        status: "idle",
        delivery: "shadow",
        endpoint: latest.endpoint,
        latestBlock,
        targetBlock,
        persistedBlock: previousRealtimeCursor,
      };
    }
    const realtimeBudget = previousRealtimeCursor == null ? cfg.initialBackfillBlocks : cfg.maxLogBlocksPerTick;
    const realtimeTipFirstBlock = Math.max(0, targetBlock - realtimeBudget + 1);
    const sequentialRealtimeFirstBlock =
      previousRealtimeCursor == null
        ? Math.max(0, targetBlock - cfg.initialBackfillBlocks + 1)
        : Math.max(0, previousRealtimeCursor - cfg.reorgOverlapBlocks + 1);
    const realtimeFirstBlock = Math.max(sequentialRealtimeFirstBlock, realtimeTipFirstBlock);
    const realtimeLastBlock = Math.min(targetBlock, realtimeFirstBlock + realtimeBudget - 1);
    const realtimeJumped = previousRealtimeCursor != null && realtimeFirstBlock > sequentialRealtimeFirstBlock;
    if (realtimeJumped && options.allowRealtimeRebase === false) {
      throw new Error(
        `realtime capacity exceeded: cursor=${previousRealtimeCursor} target=${targetBlock} capacity=${realtimeBudget}`,
      );
    }
    if (realtimeFirstBlock > realtimeLastBlock) {
      store.updateHealth({ status: "ok", endpoint: latest.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return {
        status: "idle",
        delivery: "shadow",
        endpoint: latest.endpoint,
        latestBlock,
        targetBlock,
        persistedBlock: previousRealtimeCursor,
      };
    }
    const bootstrapDiscovery = store.getState("pool_discovery_bootstrap_v1") !== "1";
    const realtimeStartBlock = realtimeJumped ? realtimeFirstBlock : (persistedRealtimeStart ?? realtimeFirstBlock);
    const priorHistoryComplete = store.getState("history_complete") === "1";
    const storedBackfillCursor =
      priorHistoryComplete && realtimeJumped
        ? legacyCursor
        : (stateNumber(store.getState("backfill_cursor")) ?? legacyCursor);
    const backfillCursor = storedBackfillCursor ?? realtimeStartBlock - 1;
    const backfillTargetBlock = realtimeStartBlock - 1;
    const historyCompleteBefore = !realtimeJumped && (priorHistoryComplete || backfillCursor >= backfillTargetBlock);
    const realtimeCursor = Math.max(previousRealtimeCursor ?? -1, realtimeLastBlock);
    const realtimeStates: Record<string, string> = {
      realtime_start_block: String(realtimeStartBlock),
      backfill_cursor: String(backfillCursor),
      history_complete: historyCompleteBefore ? "1" : "0",
    };
    if (historyCompleteBefore) realtimeStates.last_confirmed_block = String(realtimeCursor);
    const realtime = await collectPhase1Range({
      store,
      cfg,
      urls,
      transport,
      firstBlock: realtimeFirstBlock,
      lastBlock: realtimeLastBlock,
      targetBlock,
      bootstrapDiscovery,
      lane: "realtime",
      cursor: realtimeCursor,
      stateUpdates: realtimeStates,
      sleep: options.sleep,
    });
    store.updateHealth({
      status: "ok",
      endpoint: latest.endpoint,
      latestBlock,
      targetBlock,
      lagBlocks: Math.max(0, targetBlock - realtimeCursor),
    });
    let backfillStatus: RobinhoodPhase1Result["backfillStatus"] = historyCompleteBefore ? "complete" : "skipped";
    let backfillFirstBlock: number | undefined;
    let backfillLastBlock: number | undefined;
    let backfillPersistedBlock = backfillCursor;
    let backfillError: string | undefined;
    const now = Math.floor(Date.now() / 1000);
    const lastBackfillAt = stateNumber(store.getState("last_backfill_at")) ?? Number.NEGATIVE_INFINITY;
    if (!historyCompleteBefore && now - lastBackfillAt >= cfg.backfillCollectSeconds) {
      const backfillLag = Math.max(0, backfillTargetBlock - backfillCursor);
      const backfillBudget =
        backfillLag > cfg.catchUpLagBlocks ? cfg.catchUpBlocksPerTick : Math.min(cfg.maxLogBlocksPerTick, 1000);
      backfillFirstBlock = Math.max(0, backfillCursor - cfg.reorgOverlapBlocks + 1);
      backfillLastBlock = Math.min(backfillTargetBlock, backfillFirstBlock + backfillBudget - 1);
      try {
        backfillPersistedBlock = Math.max(backfillCursor, backfillLastBlock);
        const historyComplete = backfillPersistedBlock >= backfillTargetBlock;
        const states: Record<string, string> = {
          last_backfill_at: String(now),
          history_complete: historyComplete ? "1" : "0",
        };
        if (historyComplete) states.last_confirmed_block = String(realtimeCursor);
        await collectPhase1Range({
          store,
          cfg,
          urls,
          transport,
          firstBlock: backfillFirstBlock,
          lastBlock: backfillLastBlock,
          targetBlock,
          bootstrapDiscovery: false,
          lane: "backfill",
          cursor: backfillPersistedBlock,
          stateUpdates: states,
          sleep: options.sleep,
        });
        store.updateHealth({
          source: "robinhood_chain_phase1_backfill",
          status: "ok",
          endpoint: latest.endpoint,
          latestBlock: realtimeStartBlock,
          targetBlock: backfillTargetBlock,
          lagBlocks: Math.max(0, backfillTargetBlock - backfillPersistedBlock),
        });
        backfillStatus = historyComplete ? "complete" : "persisted";
      } catch (error) {
        backfillPersistedBlock = backfillCursor;
        backfillError = sanitizeErrorText(error instanceof Error ? error.message : String(error));
        store.setState("last_backfill_at", String(now));
        store.updateHealth({
          source: "robinhood_chain_phase1_backfill",
          status: "error",
          latestBlock: realtimeStartBlock,
          targetBlock: backfillTargetBlock,
          lagBlocks: Math.max(0, backfillTargetBlock - backfillCursor),
          error: backfillError,
        });
        backfillStatus = "failed";
      }
    }
    const historyComplete = store.getState("history_complete") === "1";
    return {
      status: "persisted",
      delivery: "shadow",
      endpoint: latest.endpoint,
      latestBlock,
      targetBlock,
      firstBlock: realtimeFirstBlock,
      lastBlock: realtimeLastBlock,
      persistedBlock: realtimeCursor,
      poolsDiscovered: realtime.poolsDiscovered,
      swapsObserved: realtime.swapsObserved,
      candidatesQualified: realtime.candidatesQualified,
      realtimeFirstBlock,
      realtimeLastBlock,
      realtimePersistedBlock: realtimeCursor,
      backfillStatus,
      backfillFirstBlock,
      backfillLastBlock,
      backfillPersistedBlock,
      backfillTargetBlock,
      backfillLagBlocks: Math.max(0, backfillTargetBlock - backfillPersistedBlock),
      backfillError,
      historyComplete,
    };
  } catch (error) {
    const message = sanitizeErrorText(error instanceof Error ? error.message : String(error));
    try {
      store.updateHealth({ status: "error", latestBlock, targetBlock, error: message });
      store.markQualifiedCandidatesStale("source_health_error");
    } catch {
      // Preserve the primary failure.
    }
    if (error instanceof WrongChainError) throw error;
    throw new Error(message);
  }
}
