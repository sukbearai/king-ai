import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ROBINHOOD_CHAIN_DB_PATH } from "../paths.js";
import { dotGet, type TradeConfig } from "./config.js";
import { openSqliteDb, closeSqliteDb } from "./sqlite-db.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_CHAIN_RPC_FALLBACK_URL = "https://robinhood-rpc.publicnode.com";

export interface RobinhoodChainConfig {
  enabled: boolean;
  chainId: number;
  rpcUrls: string[];
  collectSeconds: number;
  confirmations: number;
  initialBackfillBlocks: number;
  maxBlocksPerTick: number;
  rpcBatchSize: number;
  reorgOverlapBlocks: number;
  retentionDays: number;
  requestTimeoutMs: number;
  backfillCollectSeconds: number;
}

export type RpcTransport = (url: string, method: string, params: unknown[]) => Promise<unknown>;

export interface RpcBatchRequest {
  id: number;
  method: string;
  params: unknown[];
}

export type RpcBatchTransport = (url: string, requests: readonly RpcBatchRequest[]) => Promise<unknown>;

export interface RpcBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  gasUsed: number;
  transactions: Array<{ from: string; to: string | null }>;
}

export interface RobinhoodCollectionResult {
  status: "disabled" | "idle" | "persisted";
  endpoint?: string;
  latestBlock?: number;
  targetBlock?: number;
  firstBlock?: number;
  lastBlock?: number;
  persistedBlock?: number;
  lagBlocks?: number;
  fetchedBlocks?: number;
  reorgReplacements?: number;
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

export class WrongChainError extends Error {
  readonly expectedChainId = ROBINHOOD_CHAIN_ID;
  readonly observedChainIds: number[];

  constructor(observedChainIds: number[]) {
    super(
      `Robinhood Chain RPC returned wrong chain id; expected ${ROBINHOOD_CHAIN_ID}, observed ${observedChainIds.join(", ") || "none"}`,
    );
    this.name = "WrongChainError";
    this.observedChainIds = observedChainIds;
  }
}

export function sanitizeRpcUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "<invalid-rpc-url>";
  }
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const out = value.map((item) => String(item).trim()).filter(Boolean);
  return out.length ? out : fallback;
}

export function resolveRobinhoodChainConfig(config: TradeConfig): RobinhoodChainConfig {
  const raw = (dotGet(config, "data_sources.robinhood_chain", {}) ?? {}) as Record<string, unknown>;
  const chainId = Number(raw.chain_id ?? ROBINHOOD_CHAIN_ID);
  const maxBlocksPerTick = boundedInt(raw.max_blocks_per_tick, 1000, 1, 2000);
  const rpcBatchSize = boundedInt(raw.rpc_batch_size, 50, 1, 100);
  const retentionDays = boundedInt(raw.retention_days, 14, 7, 90);
  const reorgOverlapBlocks = Math.min(boundedInt(raw.reorg_overlap_blocks, 20, 1, 200), maxBlocksPerTick);
  return {
    enabled: raw.enabled === true,
    chainId,
    rpcUrls: stringArray(raw.rpc_urls, [ROBINHOOD_CHAIN_RPC_URL, ROBINHOOD_CHAIN_RPC_FALLBACK_URL]),
    collectSeconds: boundedInt(raw.collect_seconds, 30, 30, 3600),
    confirmations: boundedInt(raw.confirmations, 20, 1, 200),
    initialBackfillBlocks: boundedInt(raw.initial_backfill_blocks, 20, 1, 500),
    maxBlocksPerTick,
    rpcBatchSize,
    reorgOverlapBlocks,
    retentionDays,
    requestTimeoutMs: boundedInt(raw.request_timeout_ms, 10_000, 1000, 60_000),
    backfillCollectSeconds: boundedInt(raw.backfill_collect_seconds, 300, 30, 3600),
  };
}

function parseHex(value: unknown, field: string): number {
  const text = String(value ?? "");
  const parsed = /^0x[0-9a-f]+$/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid RPC ${field}`);
  return parsed;
}

function normalizeAddress(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function parseBlock(raw: unknown): RpcBlock {
  if (!raw || typeof raw !== "object") throw new Error("RPC returned an invalid block");
  const row = raw as Record<string, unknown>;
  const transactions = Array.isArray(row.transactions) ? row.transactions : [];
  const hash = String(row.hash ?? "");
  const parentHash = String(row.parentHash ?? "");
  if (!/^0x[0-9a-f]{64}$/i.test(hash) || !/^0x[0-9a-f]{64}$/i.test(parentHash)) {
    throw new Error("RPC returned an invalid block hash");
  }
  return {
    number: parseHex(row.number, "block number"),
    hash,
    parentHash,
    timestamp: parseHex(row.timestamp, "timestamp"),
    gasUsed: parseHex(row.gasUsed ?? "0x0", "gasUsed"),
    transactions: transactions
      .filter((tx) => tx && typeof tx === "object")
      .map((tx) => {
        const value = tx as Record<string, unknown>;
        const from = normalizeAddress(value.from);
        if (!from) throw new Error("RPC transaction has no sender");
        const to = value.to == null ? null : normalizeAddress(value.to);
        return { from, to };
      }),
  };
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
      const message = String((body.error as Record<string, unknown>).message ?? "JSON-RPC error");
      throw new Error(message.slice(0, 300));
    }
    return body.result;
  };
}

function defaultBatchTransport(timeoutMs: number): RpcBatchTransport {
  return async (url, requests) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(
        requests.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          method: request.method,
          params: request.params,
        })),
      ),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new RpcHttpError(response.status, parseRetryAfterMs(response));
    return response.json();
  };
}

function batchTransportFromSingle(transport: RpcTransport): RpcBatchTransport {
  return async (url, requests) => {
    const responses: Array<{ jsonrpc: "2.0"; id: number; result: unknown }> = [];
    for (const request of requests) {
      responses.push({
        jsonrpc: "2.0",
        id: request.id,
        result: await transport(url, request.method, request.params),
      });
    }
    return responses;
  };
}

function retryDetails(error: unknown): { retryable: boolean; retryAfterMs: number } {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof RpcHttpError ? error.status : Number(message.match(/HTTP\s+(\d{3})/i)?.[1]);
  return {
    retryable:
      status === 403 ||
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status >= 500 ||
      /timeout|timed out|fetch failed|connection|socket|network|rate limit|too many requests|request limit|limit exceeded|-32005/i.test(
        message,
      ),
    retryAfterMs: error instanceof RpcHttpError && error.retryAfterMs != null ? error.retryAfterMs : 0,
  };
}

async function callRpc(
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
        const details = retryDetails(error);
        retryable ||= details.retryable;
        retryAfterMs = Math.max(retryAfterMs, details.retryAfterMs);
      }
    }
    if (!retryable || attempt + 1 >= maxAttempts) break;
    await sleep(Math.max(retryAfterMs, Math.min(5000, retryBaseMs * 2 ** attempt)));
  }
  throw new Error(`${method} failed on all RPC endpoints: ${errors.join("; ")}`);
}

function parseBatchValues(raw: unknown, requests: readonly RpcBatchRequest[]): unknown[] {
  if (!Array.isArray(raw)) throw new Error("RPC batch returned a non-array response");
  const expectedIds = new Set(requests.map((request) => request.id));
  const values = new Map<number, unknown>();
  for (const item of raw) {
    if (!item || typeof item !== "object") throw new Error("RPC batch returned an invalid response item");
    const response = item as Record<string, unknown>;
    const id = response.id;
    if (!Number.isInteger(id) || !expectedIds.has(Number(id))) {
      throw new Error(`RPC batch returned unexpected response id ${String(id)}`);
    }
    const numericId = Number(id);
    if (values.has(numericId)) throw new Error(`RPC batch returned duplicate response id ${numericId}`);
    if (response.error && typeof response.error === "object") {
      const rpcError = response.error as Record<string, unknown>;
      const code = rpcError.code == null ? "" : ` code ${String(rpcError.code)}`;
      const message = String(rpcError.message ?? "JSON-RPC error");
      throw new Error(`RPC batch response id ${numericId} failed${code}: ${message.slice(0, 300)}`);
    }
    if (!Object.hasOwn(response, "result")) throw new Error(`RPC batch response id ${numericId} has no result`);
    values.set(numericId, response.result);
  }
  return requests.map((request) => {
    if (!values.has(request.id)) throw new Error(`RPC batch missing response id ${request.id}`);
    return values.get(request.id);
  });
}

async function callRpcBatch(
  urls: string[],
  transport: RpcBatchTransport,
  requests: readonly RpcBatchRequest[],
  options: {
    maxAttempts?: number;
    retryBaseMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ values: unknown[]; endpoint: string }> {
  const errors: string[] = [];
  const maxAttempts = Math.min(3, Math.max(1, Math.trunc(options.maxAttempts ?? 3)));
  const retryBaseMs = Math.min(5000, Math.max(100, Math.trunc(options.retryBaseMs ?? 1000)));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let retryable = false;
    let retryAfterMs = 0;
    for (const url of urls) {
      try {
        return {
          values: parseBatchValues(await transport(url, requests), requests),
          endpoint: sanitizeRpcUrl(url),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${sanitizeRpcUrl(url)}: ${sanitizeErrorText(message).slice(0, 200)}`);
        const details = retryDetails(error);
        retryable ||= details.retryable;
        retryAfterMs = Math.max(retryAfterMs, details.retryAfterMs);
      }
    }
    if (!retryable || attempt + 1 >= maxAttempts) break;
    await sleep(Math.max(retryAfterMs, Math.min(5000, retryBaseMs * 2 ** attempt)));
  }
  throw new Error(`eth_getBlockByNumber batch failed on all RPC endpoints: ${errors.join("; ")}`);
}

async function validateEndpoints(
  urls: string[],
  transport: RpcTransport,
  sleep?: (ms: number) => Promise<void>,
): Promise<string[]> {
  const observed: number[] = [];
  const errors: string[] = [];
  const valid: string[] = [];
  for (const url of urls) {
    try {
      const response = await callRpc([url], transport, "eth_chainId", [], { sleep });
      const value = parseHex(response.value, "chain id");
      observed.push(value);
      if (value === ROBINHOOD_CHAIN_ID) valid.push(url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${sanitizeRpcUrl(url)}: ${sanitizeErrorText(message).slice(0, 200)}`);
    }
  }
  if (valid.length) return valid;
  if (observed.length && observed.every((id) => id !== ROBINHOOD_CHAIN_ID)) throw new WrongChainError(observed);
  throw new Error(`unable to validate Robinhood Chain RPC: ${errors.join("; ") || "no valid chain id"}`);
}

function sanitizeErrorText(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => sanitizeRpcUrl(value));
}

async function getWithPreferred(
  preferred: string,
  urls: string[],
  transport: RpcTransport,
  method: string,
  params: unknown[],
  sleep?: (ms: number) => Promise<void>,
): Promise<{ value: unknown; endpoint: string }> {
  return callRpc([preferred, ...urls.filter((url) => url !== preferred)], transport, method, params, { sleep });
}

function windowStart(timestamp: number): number {
  return Math.floor(timestamp / 300) * 300;
}

export class RobinhoodChainStore {
  private readonly db;

  constructor(readonly path: string) {
    this.db = openSqliteDb(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collector_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_blocks (
        block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL UNIQUE, parent_hash TEXT NOT NULL,
        block_ts INTEGER NOT NULL, tx_count INTEGER NOT NULL, contract_creations INTEGER NOT NULL,
        gas_used INTEGER NOT NULL, observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS block_senders (
        block_number INTEGER NOT NULL REFERENCES chain_blocks(block_number) ON DELETE CASCADE,
        address TEXT NOT NULL, tx_count INTEGER NOT NULL, PRIMARY KEY(block_number, address)
      );
      CREATE TABLE IF NOT EXISTS activity_windows (
        window_start INTEGER PRIMARY KEY, window_end INTEGER NOT NULL, block_count INTEGER NOT NULL,
        tx_count INTEGER NOT NULL, unique_senders INTEGER NOT NULL, contract_creations INTEGER NOT NULL,
        gas_used INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS source_health (
        source TEXT PRIMARY KEY, status TEXT NOT NULL, endpoint TEXT NOT NULL, latest_block INTEGER,
        target_block INTEGER, lag_blocks INTEGER, consecutive_failures INTEGER NOT NULL,
        last_success_at INTEGER, last_error_at INTEGER, last_error TEXT
      );
    `);
  }

  getState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM collector_state WHERE key = ?").get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  }

  count(table: "chain_blocks" | "block_senders" | "activity_windows"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count?: number };
    return Number(row?.count ?? 0);
  }

  getWindowCount(): number {
    return this.count("activity_windows");
  }

  getBlockHash(blockNumber: number): string | null {
    const row = this.db.prepare("SELECT block_hash FROM chain_blocks WHERE block_number = ?").get(blockNumber) as
      | { block_hash?: string }
      | undefined;
    return row?.block_hash ?? null;
  }

  getHealthStatus(source = "robinhood_chain"): string | null {
    const row = this.db.prepare("SELECT status FROM source_health WHERE source = ?").get(source) as
      | { status?: string }
      | undefined;
    return row?.status ?? null;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO collector_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(key, value, Math.floor(Date.now() / 1000));
  }

  getHealthError(source = "robinhood_chain"): string | null {
    const row = this.db.prepare("SELECT last_error FROM source_health WHERE source = ?").get(source) as
      | { last_error?: string | null }
      | undefined;
    return row?.last_error ?? null;
  }

  updateHealth(input: {
    source?: string;
    status: string;
    endpoint?: string;
    latestBlock?: number;
    targetBlock?: number;
    lagBlocks?: number;
    error?: string;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    const source = input.source ?? "robinhood_chain";
    const current = this.db.prepare("SELECT consecutive_failures FROM source_health WHERE source = ?").get(source) as
      | { consecutive_failures?: number }
      | undefined;
    const failures = input.status === "ok" ? 0 : Number(current?.consecutive_failures ?? 0) + 1;
    this.db
      .prepare(`
      INSERT INTO source_health (source,status,endpoint,latest_block,target_block,lag_blocks,consecutive_failures,last_success_at,last_error_at,last_error)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source) DO UPDATE SET status=excluded.status, endpoint=excluded.endpoint,
        latest_block=excluded.latest_block, target_block=excluded.target_block, lag_blocks=excluded.lag_blocks,
        consecutive_failures=excluded.consecutive_failures,
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
        input.error ? input.error.slice(0, 500) : null,
      );
  }

  persistBlocks(
    blocks: RpcBlock[],
    cursor: number,
    retentionDays: number,
    lane: "legacy" | "realtime" | "backfill" = "legacy",
    stateUpdates: Record<string, string> = {},
  ): { reorgReplacements: number } {
    if (!blocks.length) return { reorgReplacements: 0 };
    const now = Math.floor(Date.now() / 1000);
    const affectedWindows = new Set(blocks.map((block) => windowStart(block.timestamp)));
    let reorgReplacements = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingBlock = this.db.prepare("SELECT block_hash, block_ts FROM chain_blocks WHERE block_number = ?");
      const deleteBlock = this.db.prepare("DELETE FROM chain_blocks WHERE block_number = ?");
      const insertBlock = this.db.prepare(
        `INSERT INTO chain_blocks (block_number,block_hash,parent_hash,block_ts,tx_count,contract_creations,gas_used,observed_at) VALUES (?,?,?,?,?,?,?,?)`,
      );
      const insertSender = this.db.prepare("INSERT INTO block_senders (block_number,address,tx_count) VALUES (?,?,?)");
      for (const block of blocks) {
        const old = existingBlock.get(block.number) as { block_hash?: string; block_ts?: number } | undefined;
        if (old?.block_hash && old.block_hash !== block.hash) reorgReplacements += 1;
        if (old?.block_ts != null) affectedWindows.add(windowStart(Number(old.block_ts)));
        deleteBlock.run(block.number);
        const senderCounts = new Map<string, number>();
        let creations = 0;
        for (const tx of block.transactions) {
          senderCounts.set(tx.from, (senderCounts.get(tx.from) ?? 0) + 1);
          if (tx.to === null) creations += 1;
        }
        insertBlock.run(
          block.number,
          block.hash,
          block.parentHash,
          block.timestamp,
          block.transactions.length,
          creations,
          block.gasUsed,
          now,
        );
        for (const [address, txCount] of senderCounts) insertSender.run(block.number, address, txCount);
      }
      const maxTs = Math.max(...blocks.map((block) => block.timestamp));
      const cutoff = maxTs - retentionDays * 86400;
      this.db.prepare("DELETE FROM chain_blocks WHERE block_ts < ?").run(cutoff);
      this.db.prepare("DELETE FROM activity_windows WHERE window_end <= ?").run(cutoff);
      for (const start of affectedWindows) {
        this.db.prepare("DELETE FROM activity_windows WHERE window_start = ?").run(start);
        const row = this.db
          .prepare(`
          SELECT COUNT(*) AS block_count, COALESCE(SUM(tx_count),0) AS tx_count,
                 COALESCE(SUM(contract_creations),0) AS contract_creations, COALESCE(SUM(gas_used),0) AS gas_used
          FROM chain_blocks WHERE block_ts >= ? AND block_ts < ?
        `)
          .get(start, start + 300) as Record<string, number>;
        const senders = this.db
          .prepare(`
          SELECT COUNT(DISTINCT bs.address) AS unique_senders FROM block_senders bs
          JOIN chain_blocks cb ON cb.block_number = bs.block_number
          WHERE cb.block_ts >= ? AND cb.block_ts < ?
        `)
          .get(start, start + 300) as { unique_senders?: number };
        if (Number(row.block_count ?? 0) > 0) {
          this.db
            .prepare(
              `INSERT INTO activity_windows (window_start,window_end,block_count,tx_count,unique_senders,contract_creations,gas_used,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
            )
            .run(
              start,
              start + 300,
              Number(row.block_count ?? 0),
              Number(row.tx_count ?? 0),
              Number(senders.unique_senders ?? 0),
              Number(row.contract_creations ?? 0),
              Number(row.gas_used ?? 0),
              now,
            );
        }
      }
      const states = {
        ...(lane === "realtime"
          ? { realtime_cursor: String(cursor) }
          : lane === "backfill"
            ? { backfill_cursor: String(cursor), last_confirmed_block: String(cursor) }
            : { last_confirmed_block: String(cursor) }),
        ...stateUpdates,
      };
      const stateStmt = this.db.prepare(
        "INSERT INTO collector_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      );
      for (const [key, value] of Object.entries(states)) stateStmt.run(key, value, now);
      this.db.exec("COMMIT");
      return { reorgReplacements };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    closeSqliteDb(this.path);
  }
}

export async function collectRobinhoodChain(options: {
  config: TradeConfig;
  dbPath?: string;
  transport?: RpcTransport;
  batchTransport?: RpcBatchTransport;
  force?: boolean;
  allowRealtimeRebase?: boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RobinhoodCollectionResult> {
  const cfg = resolveRobinhoodChainConfig(options.config);
  if (!cfg.enabled && !options.force) return { status: "disabled" };
  if (!Number.isInteger(cfg.chainId) || cfg.chainId !== ROBINHOOD_CHAIN_ID) {
    throw new WrongChainError([cfg.chainId]);
  }
  const dbPath = options.dbPath ?? ROBINHOOD_CHAIN_DB_PATH;
  await mkdir(dirname(dbPath), { recursive: true });
  const store = new RobinhoodChainStore(dbPath);
  const transport = options.transport ?? defaultTransport(cfg.requestTimeoutMs);
  const batchTransport =
    options.batchTransport ??
    (options.transport ? batchTransportFromSingle(options.transport) : defaultBatchTransport(cfg.requestTimeoutMs));
  try {
    const validUrls = await validateEndpoints(cfg.rpcUrls, transport, options.sleep);
    const latestResponse = await getWithPreferred(
      validUrls[0]!,
      validUrls,
      transport,
      "eth_blockNumber",
      [],
      options.sleep,
    );
    const latestBlock = parseHex(latestResponse.value, "latest block");
    const targetBlock = latestBlock - cfg.confirmations;
    if (targetBlock < 0) {
      store.updateHealth({ status: "ok", endpoint: latestResponse.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return {
        status: "idle",
        endpoint: sanitizeRpcUrl(latestResponse.endpoint),
        latestBlock,
        targetBlock,
        persistedBlock: nullishNumber(store.getState("last_confirmed_block")),
        lagBlocks: 0,
      };
    }
    const legacyCursor = nullishNumber(store.getState("last_confirmed_block"));
    const previousRealtimeCursor = nullishNumber(store.getState("realtime_cursor"));
    const persistedRealtimeStart = nullishNumber(store.getState("realtime_start_block"));
    const realtimeTipFirstBlock = Math.max(0, targetBlock - cfg.maxBlocksPerTick + 1);
    const sequentialRealtimeFirstBlock =
      previousRealtimeCursor == null
        ? Math.max(0, targetBlock - cfg.initialBackfillBlocks + 1)
        : Math.max(0, previousRealtimeCursor - cfg.reorgOverlapBlocks + 1);
    const realtimeFirstBlock = Math.max(sequentialRealtimeFirstBlock, realtimeTipFirstBlock);
    const realtimeLastBlock = Math.min(targetBlock, realtimeFirstBlock + cfg.maxBlocksPerTick - 1);
    const realtimeJumped = previousRealtimeCursor != null && realtimeFirstBlock > sequentialRealtimeFirstBlock;
    if (realtimeJumped && options.allowRealtimeRebase === false) {
      throw new Error(
        `realtime capacity exceeded: cursor=${previousRealtimeCursor} target=${targetBlock} capacity=${cfg.maxBlocksPerTick}`,
      );
    }
    if (realtimeFirstBlock > realtimeLastBlock) {
      store.updateHealth({ status: "ok", endpoint: latestResponse.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return {
        status: "idle",
        endpoint: sanitizeRpcUrl(latestResponse.endpoint),
        latestBlock,
        targetBlock,
        persistedBlock: previousRealtimeCursor ?? legacyCursor,
        lagBlocks: 0,
      };
    }
    const fetchRange = async (firstBlock: number, lastBlock: number, preferredEndpoint: string) => {
      const blocks = new Array<RpcBlock>(lastBlock - firstBlock + 1);
      let endpoint = preferredEndpoint;
      for (let offset = 0; offset < blocks.length; offset += cfg.rpcBatchSize) {
        const count = Math.min(cfg.rpcBatchSize, blocks.length - offset);
        const requests = Array.from({ length: count }, (_, requestIndex): RpcBatchRequest => {
          const index = offset + requestIndex;
          const number = firstBlock + index;
          return { id: index + 1, method: "eth_getBlockByNumber", params: [`0x${number.toString(16)}`, true] };
        });
        const preferred = validUrls.find((url) => sanitizeRpcUrl(url) === endpoint) ?? validUrls[0]!;
        const response = await callRpcBatch(
          [preferred, ...validUrls.filter((url) => url !== preferred)],
          batchTransport,
          requests,
          { sleep: options.sleep },
        );
        endpoint = response.endpoint;
        for (let requestIndex = 0; requestIndex < response.values.length; requestIndex += 1) {
          const index = offset + requestIndex;
          const number = firstBlock + index;
          const block = parseBlock(response.values[requestIndex]);
          if (block.number !== number)
            throw new Error(`RPC returned block ${block.number} for requested block ${number}`);
          blocks[index] = block;
        }
      }
      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index]!;
        const previous = blocks[index - 1];
        if (previous && block.parentHash.toLowerCase() !== previous.hash.toLowerCase()) {
          throw new Error(`RPC returned a discontinuous block batch at ${block.number}`);
        }
      }
      const predecessorHash = firstBlock > 0 ? store.getBlockHash(firstBlock - 1) : null;
      if (predecessorHash && blocks[0]!.parentHash.toLowerCase() !== predecessorHash.toLowerCase()) {
        throw new Error(`RPC block ${firstBlock} does not connect to retained predecessor ${firstBlock - 1}`);
      }
      return { blocks, endpoint };
    };

    const realtime = await fetchRange(realtimeFirstBlock, realtimeLastBlock, latestResponse.endpoint);
    const realtimeStartBlock = realtimeJumped ? realtimeFirstBlock : (persistedRealtimeStart ?? realtimeFirstBlock);
    const priorHistoryComplete = store.getState("history_complete") === "1";
    const initialBackfillCursor =
      priorHistoryComplete && realtimeJumped
        ? legacyCursor
        : (nullishNumber(store.getState("backfill_cursor")) ?? legacyCursor);
    const freshDatabase = initialBackfillCursor == null;
    const backfillCursor = freshDatabase ? realtimeStartBlock - 1 : initialBackfillCursor;
    const historyCompleteBefore = !realtimeJumped && (priorHistoryComplete || backfillCursor >= realtimeStartBlock - 1);
    const realtimeCursor = Math.max(previousRealtimeCursor ?? -1, realtimeLastBlock);
    const realtimeStates: Record<string, string> = {
      realtime_start_block: String(realtimeStartBlock),
      backfill_cursor: String(backfillCursor),
      history_complete: historyCompleteBefore ? "1" : "0",
    };
    if (historyCompleteBefore) realtimeStates.last_confirmed_block = String(realtimeCursor);
    const persisted = store.persistBlocks(
      realtime.blocks,
      realtimeCursor,
      cfg.retentionDays,
      "realtime",
      realtimeStates,
    );
    store.updateHealth({
      status: "ok",
      endpoint: realtime.endpoint,
      latestBlock,
      targetBlock,
      lagBlocks: Math.max(0, targetBlock - realtimeCursor),
    });
    let backfillStatus: RobinhoodCollectionResult["backfillStatus"] = historyCompleteBefore ? "complete" : "skipped";
    let backfillFirstBlock: number | undefined;
    let backfillLastBlock: number | undefined;
    let backfillPersistedBlock = backfillCursor;
    let backfillError: string | undefined;
    const backfillTargetBlock = realtimeStartBlock - 1;
    const now = Math.floor(Date.now() / 1000);
    const lastBackfillAt = nullishNumber(store.getState("last_backfill_at")) ?? Number.NEGATIVE_INFINITY;
    if (!historyCompleteBefore && now - lastBackfillAt >= cfg.backfillCollectSeconds) {
      backfillFirstBlock = Math.max(0, backfillCursor - cfg.reorgOverlapBlocks + 1);
      backfillLastBlock = Math.min(backfillTargetBlock, backfillFirstBlock + cfg.maxBlocksPerTick - 1);
      try {
        const backfill = await fetchRange(backfillFirstBlock, backfillLastBlock, realtime.endpoint);
        backfillPersistedBlock = Math.max(backfillCursor, backfillLastBlock);
        const historyComplete = backfillPersistedBlock >= backfillTargetBlock;
        const states: Record<string, string> = {
          last_backfill_at: String(now),
          history_complete: historyComplete ? "1" : "0",
        };
        if (historyComplete) states.last_confirmed_block = String(realtimeCursor);
        store.persistBlocks(backfill.blocks, backfillPersistedBlock, cfg.retentionDays, "backfill", states);
        store.updateHealth({
          source: "robinhood_chain_backfill",
          status: "ok",
          endpoint: backfill.endpoint,
          latestBlock: realtimeStartBlock,
          targetBlock: backfillTargetBlock,
          lagBlocks: Math.max(0, backfillTargetBlock - backfillPersistedBlock),
        });
        backfillStatus = historyComplete ? "complete" : "persisted";
      } catch (error) {
        backfillError = sanitizeErrorText(error instanceof Error ? error.message : String(error));
        store.setState("last_backfill_at", String(now));
        store.updateHealth({
          source: "robinhood_chain_backfill",
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
      endpoint: sanitizeRpcUrl(realtime.endpoint),
      latestBlock,
      targetBlock,
      firstBlock: realtimeFirstBlock,
      lastBlock: realtimeLastBlock,
      persistedBlock: realtimeCursor,
      lagBlocks: Math.max(0, targetBlock - realtimeCursor),
      fetchedBlocks: realtime.blocks.length,
      reorgReplacements: persisted.reorgReplacements,
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
      store.updateHealth({ status: "error", error: message });
    } catch {
      // Preserve the primary collection failure if health persistence itself fails.
    }
    if (error instanceof WrongChainError) throw error;
    throw new Error(message);
  }
}

function nullishNumber(value: string | null): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
