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
  type RpcTransport,
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

describe("Robinhood Chain Phase 0", () => {
  it("bounds config and redacts RPC credentials", () => {
    const resolved = resolveRobinhoodChainConfig(config({ collect_seconds: 1, confirmations: 999 }));
    assert.equal(resolved.collectSeconds, 30);
    assert.equal(resolved.confirmations, 200);
    const defaults = resolveRobinhoodChainConfig({ data_sources: { robinhood_chain: {} } });
    assert.equal(defaults.maxBlocksPerTick, 1000);
    assert.equal(defaults.rpcConcurrency, 16);
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

  it("bounds concurrent block reads and keeps the batch ordered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-concurrency-"));
    let inFlight = 0;
    let maxInFlight = 0;
    const base = transportFor({ latest: 110 });
    const transport: RpcTransport = async (url, method, params) => {
      if (method === "eth_getBlockByNumber") {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await base(url, method, params);
        } finally {
          inFlight -= 1;
        }
      }
      return base(url, method, params);
    };
    try {
      const result = await collectRobinhoodChain({
        config: config({ initial_backfill_blocks: 10, rpc_concurrency: 2 }),
        dbPath: join(dir, "rh.sqlite"),
        transport,
      });
      assert.equal(result.fetchedBlocks, 10);
      assert.ok(maxInFlight <= 2);
      assert.equal(result.firstBlock, 99);
      assert.equal(result.lastBlock, 108);
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
    await runRobinhoodChainCollectorJob(
      config(),
      async () => {
        throw new Error("RPC offline");
      },
      (line) => lines.push(line),
    );
    assert.deepEqual(lines, ["[robinhood-chain] failed: RPC offline"]);
  });
});
