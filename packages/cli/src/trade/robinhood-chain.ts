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
  rpcConcurrency: number;
  reorgOverlapBlocks: number;
  retentionDays: number;
  requestTimeoutMs: number;
}

export type RpcTransport = (url: string, method: string, params: unknown[]) => Promise<unknown>;

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
  const rpcConcurrency = boundedInt(raw.rpc_concurrency, 16, 1, 32);
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
    rpcConcurrency,
    reorgOverlapBlocks,
    retentionDays,
    requestTimeoutMs: boundedInt(raw.request_timeout_ms, 10_000, 1000, 60_000),
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

function defaultTransport(timeoutMs: number): RpcTransport {
  return async (url, method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (body.error && typeof body.error === "object") {
      const message = String((body.error as Record<string, unknown>).message ?? "JSON-RPC error");
      throw new Error(message.slice(0, 300));
    }
    return body.result;
  };
}

async function callRpc(
  urls: string[],
  transport: RpcTransport,
  method: string,
  params: unknown[],
): Promise<{ value: unknown; endpoint: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return { value: await transport(url, method, params), endpoint: sanitizeRpcUrl(url) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${sanitizeRpcUrl(url)}: ${sanitizeErrorText(message).slice(0, 200)}`);
    }
  }
  throw new Error(`${method} failed on all RPC endpoints: ${errors.join("; ")}`);
}

async function validateEndpoints(urls: string[], transport: RpcTransport): Promise<string[]> {
  const observed: number[] = [];
  const errors: string[] = [];
  const valid: string[] = [];
  for (const url of urls) {
    try {
      const value = parseHex(await transport(url, "eth_chainId", []), "chain id");
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
): Promise<{ value: unknown; endpoint: string }> {
  return callRpc([preferred, ...urls.filter((url) => url !== preferred)], transport, method, params);
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

  getHealthError(source = "robinhood_chain"): string | null {
    const row = this.db.prepare("SELECT last_error FROM source_health WHERE source = ?").get(source) as
      | { last_error?: string | null }
      | undefined;
    return row?.last_error ?? null;
  }

  updateHealth(input: {
    status: string;
    endpoint?: string;
    latestBlock?: number;
    targetBlock?: number;
    lagBlocks?: number;
    error?: string;
  }): void {
    const now = Math.floor(Date.now() / 1000);
    const current = this.db
      .prepare("SELECT consecutive_failures FROM source_health WHERE source = ?")
      .get("robinhood_chain") as { consecutive_failures?: number } | undefined;
    const failures = input.status === "ok" ? 0 : Number(current?.consecutive_failures ?? 0) + 1;
    this.db
      .prepare(`
      INSERT INTO source_health (source,status,endpoint,latest_block,target_block,lag_blocks,consecutive_failures,last_success_at,last_error_at,last_error)
      VALUES ('robinhood_chain',?,?,?,?,?,?,?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET status=excluded.status, endpoint=excluded.endpoint,
        latest_block=excluded.latest_block, target_block=excluded.target_block, lag_blocks=excluded.lag_blocks,
        consecutive_failures=excluded.consecutive_failures,
        last_success_at=CASE WHEN excluded.status='ok' THEN excluded.last_success_at ELSE source_health.last_success_at END,
        last_error_at=CASE WHEN excluded.status='ok' THEN source_health.last_error_at ELSE excluded.last_error_at END,
        last_error=CASE WHEN excluded.status='ok' THEN NULL ELSE excluded.last_error END
    `)
      .run(
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

  persistBlocks(blocks: RpcBlock[], cursor: number, retentionDays: number): { reorgReplacements: number } {
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
      this.db
        .prepare(
          `INSERT INTO collector_state (key,value,updated_at) VALUES ('last_confirmed_block',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
        )
        .run(String(cursor), now);
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
  force?: boolean;
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
  try {
    const validUrls = await validateEndpoints(cfg.rpcUrls, transport);
    const latestResponse = await getWithPreferred(validUrls[0]!, validUrls, transport, "eth_blockNumber", []);
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
    const previousCursor = nullishNumber(store.getState("last_confirmed_block"));
    const firstBlock =
      previousCursor == null
        ? Math.max(0, targetBlock - cfg.initialBackfillBlocks + 1)
        : Math.max(0, previousCursor - cfg.reorgOverlapBlocks + 1);
    const lastBlock = Math.min(targetBlock, firstBlock + cfg.maxBlocksPerTick - 1);
    if (firstBlock > lastBlock) {
      store.updateHealth({ status: "ok", endpoint: latestResponse.endpoint, latestBlock, targetBlock, lagBlocks: 0 });
      return {
        status: "idle",
        endpoint: sanitizeRpcUrl(latestResponse.endpoint),
        latestBlock,
        targetBlock,
        persistedBlock: previousCursor ?? undefined,
        lagBlocks: 0,
      };
    }
    const blocks = new Array<RpcBlock>(lastBlock - firstBlock + 1);
    let endpoint = latestResponse.endpoint;
    let nextIndex = 0;
    let batchError: unknown = null;
    const workerCount = Math.min(cfg.rpcConcurrency, blocks.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          if (batchError) return;
          const index = nextIndex++;
          if (index >= blocks.length) return;
          const number = firstBlock + index;
          try {
            const preferred = validUrls.find((url) => sanitizeRpcUrl(url) === endpoint) ?? validUrls[0]!;
            const response = await getWithPreferred(preferred, validUrls, transport, "eth_getBlockByNumber", [
              `0x${number.toString(16)}`,
              true,
            ]);
            endpoint = response.endpoint;
            const block = parseBlock(response.value);
            if (block.number !== number) {
              throw new Error(`RPC returned block ${block.number} for requested block ${number}`);
            }
            blocks[index] = block;
          } catch (error) {
            batchError ??= error;
            return;
          }
        }
      }),
    );
    if (batchError) throw batchError;
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
    const persistedCursor = Math.max(previousCursor ?? -1, lastBlock);
    const persisted = store.persistBlocks(blocks, persistedCursor, cfg.retentionDays);
    store.updateHealth({
      status: "ok",
      endpoint,
      latestBlock,
      targetBlock,
      lagBlocks: Math.max(0, targetBlock - persistedCursor),
    });
    return {
      status: "persisted",
      endpoint: sanitizeRpcUrl(endpoint),
      latestBlock,
      targetBlock,
      firstBlock,
      lastBlock,
      persistedBlock: persistedCursor,
      lagBlocks: Math.max(0, targetBlock - persistedCursor),
      fetchedBlocks: blocks.length,
      reorgReplacements: persisted.reorgReplacements,
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
