import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  collectRobinhoodChain,
  resolveRobinhoodChainConfig,
  sanitizeRpcUrl,
  RobinhoodChainStore,
  WrongChainError,
  type RpcBatchTransport,
  type RpcTransport,
  type RobinhoodCollectionResult,
} from "../src/trade/robinhood-chain.js";
import { runRobinhoodChainCollectorJob } from "../src/trade/scheduler.js";

function hex(value: number): string {
  return `0x${value.toString(16)}`;
}

function transportFor(options: {
  chainId?: number;
  latest?: number;
  blocks?: Record<number, unknown>;
  failAt?: number;
}): RpcTransport {
  return async (_url: string, method: string, params: unknown[]) => {
    if (method === "eth_chainId") return hex(options.chainId ?? 4663);
    if (method === "eth_blockNumber") return hex(options.latest ?? 100);
    if (method === "eth_getBlockByNumber") {
      const number = Number.parseInt(String(params?.[0]).slice(2), 16);
      if (options.failAt === number) throw new Error(`block ${number} unavailable`);
      return (
        options.blocks?.[number] ?? {
          number: hex(number),
          hash: `0x${number.toString(16).padStart(64, "0")}`,
          parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
          timestamp: hex(1_700_000_100 + (number % 10) * 10),
          gasUsed: hex(21_000),
          transactions: [{ from: `0x${"a".repeat(39)}${number % 10}`, to: `0x${"b".repeat(40)}` }],
        }
      );
    }
    throw new Error(`unexpected method ${method}`);
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        confirmations: 2,
        initial_backfill_blocks: 3,
        max_blocks_per_tick: 100,
        reorg_overlap_blocks: 2,
        retention_days: 7,
        ...overrides,
      },
    },
  };
}

function batchOptions(input: {
  config: ReturnType<typeof config>;
  dbPath: string;
  transport: RpcTransport;
  batchTransport: RpcBatchTransport;
  sleep?: (ms: number) => Promise<void>;
}): Parameters<typeof collectRobinhoodChain>[0] {
  return input;
}

describe("Robinhood Chain Phase 0", () => {
  it("bounds config and redacts RPC credentials", () => {
    const resolved = resolveRobinhoodChainConfig(config({ collect_seconds: 1, confirmations: 999 }));
    assert.equal(resolved.collectSeconds, 30);
    assert.equal(resolved.confirmations, 200);
    const defaults = resolveRobinhoodChainConfig({ data_sources: { robinhood_chain: {} } });
    assert.equal(defaults.maxBlocksPerTick, 1000);
    assert.equal(defaults.rpcBatchSize, 50);
    assert.equal(defaults.backfillCollectSeconds, 300);
    const bounded = resolveRobinhoodChainConfig(config({ rpc_batch_size: 999, rpc_concurrency: 32 }));
    assert.equal(bounded.rpcBatchSize, 100);
    assert.equal(resolveRobinhoodChainConfig(config({ backfill_collect_seconds: 1 })).backfillCollectSeconds, 30);
    assert.equal(sanitizeRpcUrl("https://user:secret@example.test/rpc?token=abc#x"), "https://example.test/rpc");
  });

  it("does not create durable state while disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-disabled-"));
    const dbPath = join(dir, "rh.sqlite");
    try {
      const result = await collectRobinhoodChain({ config: {}, dbPath, transport: transportFor({}) });
      assert.equal(result.status, "disabled");
      await assert.rejects(() => access(dbPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not reject inactive source settings until collection is requested", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-disabled-chain-"));
    const dbPath = join(dir, "rh.sqlite");
    try {
      const result = await collectRobinhoodChain({
        config: { data_sources: { robinhood_chain: { enabled: false, chain_id: 1 } } },
        dbPath,
        transport: transportFor({}),
      });
      assert.equal(result.status, "disabled");
      await assert.rejects(() => access(dbPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails over to a healthy RPC without exposing credentials", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-failover-"));
    const dbPath = join(dir, "rh.sqlite");
    const rpcUrls = ["https://user:secret@bad.example/rpc?token=abc", "https://good.example/rpc?token=def"];
    const transport: RpcTransport = async (url, method, params) => {
      if (url.includes("bad.example")) throw new Error(`unavailable ${url}`);
      return transportFor({ latest: 100 })(url, method, params);
    };
    try {
      const result = await collectRobinhoodChain({ config: config({ rpc_urls: rpcUrls }), dbPath, transport });
      assert.equal(result.endpoint, "https://good.example/rpc");
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.getHealthStatus(), "ok");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when all endpoints report the wrong chain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-wrong-"));
    try {
      await assert.rejects(
        () =>
          collectRobinhoodChain({
            config: config(),
            dbPath: join(dir, "rh.sqlite"),
            transport: transportFor({ chainId: 1 }),
          }),
        (error: unknown) => error instanceof WrongChainError && /4663/.test(error.message),
      );
      const store = new RobinhoodChainStore(join(dir, "rh.sqlite"));
      assert.equal(store.count("chain_blocks"), 0);
      assert.equal(store.getHealthStatus(), "error");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts credentials from persisted and thrown source errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-redact-"));
    const dbPath = join(dir, "rh.sqlite");
    const secretUrl = "https://user:secret@rpc.example/rpc?token=abc";
    const transport: RpcTransport = async () => {
      throw new Error(`connection failed for ${secretUrl}; retry denied`);
    };
    try {
      await assert.rejects(
        () => collectRobinhoodChain({ config: config({ rpc_urls: [secretUrl] }), dbPath, transport }),
        (error: unknown) =>
          error instanceof Error && !error.message.includes("secret") && !error.message.includes("token=abc"),
      );
      const store = new RobinhoodChainStore(dbPath);
      const persisted = store.getHealthError() ?? "";
      assert.equal(persisted.includes("secret"), false);
      assert.equal(persisted.includes("token=abc"), false);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists a bounded first backfill and exact five-minute windows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-first-"));
    const dbPath = join(dir, "rh.sqlite");
    try {
      const result = await collectRobinhoodChain({
        config: config(),
        dbPath,
        transport: transportFor({ latest: 100 }),
      });
      assert.equal(result.status, "persisted");
      assert.equal(result.firstBlock, 96);
      assert.equal(result.lastBlock, 98);
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.count("chain_blocks"), 3);
      assert.equal(store.getState("last_confirmed_block"), "98");
      assert.equal(store.getWindowCount(), 1);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates an existing cursor into independent realtime and backfill coverage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-dual-lane-"));
    const dbPath = join(dir, "rh.sqlite");
    const store = new RobinhoodChainStore(dbPath);
    const seeded = await transportFor({ latest: 102 })("https://rpc.example", "eth_getBlockByNumber", [hex(100), true]);
    store.persistBlocks(
      [
        {
          number: 100,
          hash: String((seeded as Record<string, unknown>).hash),
          parentHash: String((seeded as Record<string, unknown>).parentHash),
          timestamp: Number.parseInt(String((seeded as Record<string, unknown>).timestamp).slice(2), 16),
          gasUsed: 21_000,
          transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
        },
      ],
      100,
      7,
    );
    store.close();
    try {
      const result = await collectRobinhoodChain({
        config: config({ initial_backfill_blocks: 3, max_blocks_per_tick: 5 }),
        dbPath,
        transport: transportFor({ latest: 1000 }),
      });
      const lanes = result as RobinhoodCollectionResult & Record<string, number | undefined>;
      const migrated = new RobinhoodChainStore(dbPath);
      assert.equal(lanes.realtimeFirstBlock, 996);
      assert.equal(lanes.realtimePersistedBlock, 998);
      assert.equal(lanes.backfillFirstBlock, 99);
      assert.equal(lanes.backfillPersistedBlock, 103);
      assert.equal(migrated.getState("realtime_start_block"), "996");
      assert.equal(migrated.getState("realtime_cursor"), "998");
      assert.equal(migrated.getState("backfill_cursor"), "103");
      assert.equal(migrated.getState("last_confirmed_block"), "103");
      assert.equal(migrated.getState("history_complete"), "0");
      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps committed realtime health when a bounded historical backfill batch fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-backfill-failure-"));
    const dbPath = join(dir, "rh.sqlite");
    const seed = new RobinhoodChainStore(dbPath);
    const base = transportFor({ latest: 1000 });
    const raw = (await base("https://rpc.example", "eth_getBlockByNumber", [hex(100), true])) as Record<
      string,
      unknown
    >;
    seed.persistBlocks(
      [
        {
          number: 100,
          hash: String(raw.hash),
          parentHash: String(raw.parentHash),
          timestamp: Number.parseInt(String(raw.timestamp).slice(2), 16),
          gasUsed: 21_000,
          transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
        },
      ],
      100,
      7,
    );
    seed.close();
    const batchTransport: RpcBatchTransport = async (url, requests) => {
      const first = Number.parseInt(String(requests[0]!.params[0]).slice(2), 16);
      if (first < 500) throw new Error("HTTP 429");
      return await Promise.all(
        requests.map(async (request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: await base(url, request.method, request.params),
        })),
      );
    };
    try {
      const result = await collectRobinhoodChain({
        config: config({ initial_backfill_blocks: 3, max_blocks_per_tick: 5 }),
        dbPath,
        transport: base,
        batchTransport,
        sleep: async () => undefined,
      });
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(result.status, "persisted");
      assert.equal(result.backfillStatus, "failed");
      assert.equal(store.getHealthStatus(), "ok");
      assert.equal(store.getHealthStatus("robinhood_chain_backfill"), "error");
      assert.equal(store.getState("realtime_cursor"), "998");
      assert.equal(store.getState("last_confirmed_block"), "100");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reopens backfill coverage while jumping realtime to the tip after downtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-realtime-gap-"));
    const dbPath = join(dir, "rh.sqlite");
    const store = new RobinhoodChainStore(dbPath);
    const base = transportFor({ latest: 200 });
    const block = (await base("https://rpc.example", "eth_getBlockByNumber", [hex(100), true])) as Record<
      string,
      unknown
    >;
    store.persistBlocks(
      [
        {
          number: 100,
          hash: String(block.hash),
          parentHash: String(block.parentHash),
          timestamp: Number.parseInt(String(block.timestamp).slice(2), 16),
          gasUsed: 21_000,
          transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
        },
      ],
      100,
      7,
      "realtime",
      {
        realtime_start_block: "96",
        backfill_cursor: "95",
        last_confirmed_block: "100",
        history_complete: "1",
      },
    );
    store.close();
    try {
      const result = await collectRobinhoodChain({
        config: config({ max_blocks_per_tick: 5, initial_backfill_blocks: 3 }),
        dbPath,
        transport: transportFor({ latest: 1000 }),
      });
      const reopened = new RobinhoodChainStore(dbPath);
      assert.equal(result.realtimeFirstBlock, 994);
      assert.equal(reopened.getState("realtime_start_block"), "994");
      assert.equal(reopened.getState("history_complete"), "0");
      assert.equal(result.backfillFirstBlock, 99);
      assert.equal(result.backfillTargetBlock, 993);
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails freshness without moving the fixed history boundary when an in-process cycle exceeds capacity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-realtime-capacity-"));
    const dbPath = join(dir, "rh.sqlite");
    const store = new RobinhoodChainStore(dbPath);
    const base = transportFor({ latest: 200 });
    const block = (await base("https://rpc.example", "eth_getBlockByNumber", [hex(100), true])) as Record<
      string,
      unknown
    >;
    store.persistBlocks(
      [
        {
          number: 100,
          hash: String(block.hash),
          parentHash: String(block.parentHash),
          timestamp: Number.parseInt(String(block.timestamp).slice(2), 16),
          gasUsed: 21_000,
          transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
        },
      ],
      100,
      7,
      "realtime",
      {
        realtime_start_block: "96",
        backfill_cursor: "95",
        last_confirmed_block: "95",
        history_complete: "0",
      },
    );
    store.close();
    try {
      await assert.rejects(
        () =>
          collectRobinhoodChain({
            config: config({ max_blocks_per_tick: 5, initial_backfill_blocks: 3 }),
            dbPath,
            transport: transportFor({ latest: 1000 }),
            allowRealtimeRebase: false,
          } as Parameters<typeof collectRobinhoodChain>[0]),
        /realtime capacity exceeded/,
      );
      const unchanged = new RobinhoodChainStore(dbPath);
      assert.equal(unchanged.getState("realtime_start_block"), "96");
      assert.equal(unchanged.getState("realtime_cursor"), "100");
      assert.equal(unchanged.getState("backfill_cursor"), "95");
      assert.equal(unchanged.getState("history_complete"), "0");
      assert.equal(unchanged.getHealthStatus(), "error");
      unchanged.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("closes the fixed historical gap and advances the rollback cursor to realtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-history-close-"));
    const dbPath = join(dir, "rh.sqlite");
    const store = new RobinhoodChainStore(dbPath);
    const base = transportFor({ latest: 105 });
    const raw = (await base("https://rpc.example", "eth_getBlockByNumber", [hex(99), true])) as Record<string, unknown>;
    store.persistBlocks(
      [
        {
          number: 99,
          hash: String(raw.hash),
          parentHash: String(raw.parentHash),
          timestamp: Number.parseInt(String(raw.timestamp).slice(2), 16),
          gasUsed: 21_000,
          transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
        },
      ],
      99,
      7,
    );
    store.close();
    try {
      const result = await collectRobinhoodChain({ config: config(), dbPath, transport: base });
      const closed = new RobinhoodChainStore(dbPath);
      assert.equal(result.historyComplete, true);
      assert.equal(result.backfillStatus, "complete");
      assert.equal(closed.getState("backfill_cursor"), "100");
      assert.equal(closed.getState("last_confirmed_block"), "103");
      assert.equal(closed.getState("history_complete"), "1");
      closed.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses one bounded block batch at a time and matches shuffled response ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-batch-"));
    let inFlight = 0;
    let maxInFlight = 0;
    const batchSizes: number[] = [];
    const base = transportFor({ latest: 110 });
    const batchTransport: RpcBatchTransport = async (url, requests) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      batchSizes.push(requests.length);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        const responses = await Promise.all(
          requests.map(async (request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result: await base(url, request.method, request.params),
          })),
        );
        return responses.reverse();
      } finally {
        inFlight -= 1;
      }
    };
    try {
      const result = await collectRobinhoodChain(
        batchOptions({
          config: config({ initial_backfill_blocks: 10, rpc_batch_size: 3 }),
          dbPath: join(dir, "rh.sqlite"),
          transport: async (url, method, params) => {
            if (method === "eth_getBlockByNumber") throw new Error("single block transport used");
            return base(url, method, params);
          },
          batchTransport,
        }),
      );
      assert.equal(result.fetchedBlocks, 10);
      assert.equal(maxInFlight, 1);
      assert.deepEqual(batchSizes, [3, 3, 3, 1]);
      assert.equal(result.firstBlock, 99);
      assert.equal(result.lastBlock, 108);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a block batch response is incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-batch-partial-"));
    const dbPath = join(dir, "rh.sqlite");
    const base = transportFor({ latest: 105 });
    try {
      await collectRobinhoodChain({ config: config(), dbPath, transport: transportFor({ latest: 100 }) });
      await assert.rejects(
        () =>
          collectRobinhoodChain(
            batchOptions({
              config: config({ max_blocks_per_tick: 10, rpc_batch_size: 4 }),
              dbPath,
              transport: base,
              batchTransport: async (url, requests) =>
                Promise.all(
                  requests.slice(0, -1).map(async (request) => ({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: await base(url, request.method, request.params),
                  })),
                ),
            }),
          ),
        /missing response/i,
      );
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.getState("last_confirmed_block"), "98");
      assert.equal(store.count("chain_blocks"), 3);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate batch response ids without advancing the cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-batch-duplicate-"));
    const dbPath = join(dir, "rh.sqlite");
    const base = transportFor({ latest: 100 });
    try {
      await assert.rejects(
        () =>
          collectRobinhoodChain(
            batchOptions({
              config: config({ initial_backfill_blocks: 4, rpc_batch_size: 4 }),
              dbPath,
              transport: base,
              batchTransport: async (url, requests) => {
                const responses = await Promise.all(
                  requests.map(async (request) => ({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: await base(url, request.method, request.params),
                  })),
                );
                responses[1]!.id = responses[0]!.id;
                return responses;
              },
            }),
          ),
        /duplicate response id/i,
      );
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.getState("last_confirmed_block"), null);
      assert.equal(store.count("chain_blocks"), 0);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rotates endpoints after a transient block batch failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-batch-retry-"));
    const base = transportFor({ latest: 100 });
    const urls: string[] = [];
    const batchTransport: RpcBatchTransport = async (url, requests) => {
      urls.push(url);
      if (url.includes("first.example")) throw new Error("HTTP 429");
      return Promise.all(
        requests.map(async (request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: await base(url, request.method, request.params),
        })),
      );
    };
    try {
      const result = await collectRobinhoodChain(
        batchOptions({
          config: config({
            rpc_urls: ["https://first.example", "https://second.example"],
            rpc_batch_size: 4,
          }),
          dbPath: join(dir, "rh.sqlite"),
          transport: base,
          batchTransport,
          sleep: async () => undefined,
        }),
      );
      assert.equal(result.status, "persisted");
      assert.deepEqual(urls.slice(0, 2), ["https://first.example", "https://second.example"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a JSON-RPC rate-limit error returned inside a block batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-batch-rpc-limit-"));
    const base = transportFor({ latest: 100 });
    let attempts = 0;
    const batchTransport: RpcBatchTransport = async (url, requests) => {
      attempts += 1;
      if (attempts === 1) {
        return requests.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32005, message: "rate limit exceeded" },
        }));
      }
      return Promise.all(
        requests.map(async (request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: await base(url, request.method, request.params),
        })),
      );
    };
    try {
      const result = await collectRobinhoodChain(
        batchOptions({
          config: config({ rpc_urls: ["https://only.example"], rpc_batch_size: 4 }),
          dbPath: join(dir, "rh.sqlite"),
          transport: base,
          batchTransport,
          sleep: async () => undefined,
        }),
      );
      assert.equal(result.status, "persisted");
      assert.equal(attempts, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not advance the cursor after a partial fetch failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-partial-"));
    const dbPath = join(dir, "rh.sqlite");
    try {
      const first = await collectRobinhoodChain({ config: config(), dbPath, transport: transportFor({ latest: 100 }) });
      assert.equal(first.lastBlock, 98);
      await assert.rejects(() =>
        collectRobinhoodChain({
          config: config({ max_blocks_per_tick: 10 }),
          dbPath,
          transport: transportFor({ latest: 105, failAt: 100 }),
        }),
      );
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.getState("last_confirmed_block"), "98");
      assert.equal(store.count("chain_blocks"), 3);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a transient block read before failing the batch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-block-retry-"));
    const attempts = new Map<number, number>();
    const base = transportFor({ latest: 100 });
    const transport: RpcTransport = async (url, method, params) => {
      if (method === "eth_getBlockByNumber") {
        const number = Number.parseInt(String(params[0]).slice(2), 16);
        const count = (attempts.get(number) ?? 0) + 1;
        attempts.set(number, count);
        if (number === 96 && count === 1) throw new Error("HTTP 429");
      }
      return base(url, method, params);
    };
    try {
      const result = await collectRobinhoodChain({
        config: config({ rpc_urls: ["https://only.example"] }),
        dbPath: join(dir, "rh.sqlite"),
        transport,
        sleep: async () => undefined,
      });
      assert.equal(result.status, "persisted");
      assert.equal(attempts.get(96), 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays overlap idempotently and replaces a changed block hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-reorg-"));
    const dbPath = join(dir, "rh.sqlite");
    try {
      await collectRobinhoodChain({ config: config(), dbPath, transport: transportFor({ latest: 100 }) });
      const replacement = {
        number: hex(98),
        hash: `0x${"c".repeat(64)}`,
        parentHash: `0x${(97).toString(16).padStart(64, "0")}`,
        timestamp: hex(1_700_000_180),
        gasUsed: hex(42_000),
        transactions: [
          { from: `0x${"e".repeat(40)}`, to: null },
          { from: `0x${"e".repeat(40)}`, to: `0x${"f".repeat(40)}` },
        ],
      };
      const second = await collectRobinhoodChain({
        config: config(),
        dbPath,
        transport: transportFor({ latest: 100, blocks: { 98: replacement } }),
      });
      assert.equal(second.reorgReplacements, 1);
      const store = new RobinhoodChainStore(dbPath);
      assert.equal(store.count("chain_blocks"), 3);
      assert.equal(store.count("block_senders"), 3);
      assert.equal(store.getBlockHash(98), replacement.hash);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes expired block and window data without deleting the cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-retention-"));
    const dbPath = join(dir, "rh.sqlite");
    const store = new RobinhoodChainStore(dbPath);
    const block = (number: number, timestamp: number) => ({
      number,
      hash: `0x${number.toString(16).padStart(64, "0")}`,
      parentHash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
      timestamp,
      gasUsed: 21_000,
      transactions: [{ from: `0x${"a".repeat(40)}`, to: `0x${"b".repeat(40)}` }],
    });
    try {
      store.persistBlocks([block(1, 1_700_000_000)], 1, 7);
      store.persistBlocks([block(2, 1_700_000_000 + 8 * 86400)], 2, 7);
      assert.equal(store.count("chain_blocks"), 1);
      assert.equal(store.getState("last_confirmed_block"), "2");
      assert.equal(store.getWindowCount(), 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates auxiliary collector failures from the scheduler caller", async () => {
    const lines: string[] = [];
    let permission: boolean | undefined;
    await runRobinhoodChainCollectorJob(
      config(),
      async (options) => {
        permission = options.allowRealtimeRebase;
        throw new Error("RPC offline");
      },
      (line) => lines.push(line),
      false,
    );
    assert.equal(permission, false);
    assert.deepEqual(lines, ["[robinhood-chain] failed: RPC offline"]);
  });
});
