import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BUILTIN_ROBINHOOD_PROTOCOLS,
  RobinhoodPhase1Store,
  collectRobinhoodPhase1,
  collectRobinhoodPhase1Accounts,
  decodePoolCreatedLog,
  decodeSwapLog,
  evaluateTrendCandidate,
  resolveRobinhoodPhase1Config,
  type Phase1RpcLog,
} from "../src/trade/robinhood-chain-phase1.js";
import type { RpcTransport } from "../src/trade/robinhood-chain.js";
import { runRobinhoodPhase1CollectorJob } from "../src/trade/scheduler.js";

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address: string) => address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const topicAddress = (address: string) => `0x${addressWord(address)}`;
const hex = (value: number) => `0x${value.toString(16)}`;
const txHash = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;

const TOKEN0 = `0x${"1".repeat(40)}`;
const TOKEN1 = `0x${"4".repeat(40)}`;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const POOL = `0x${"3".repeat(40)}`;
const NON_STABLE_POOL = `0x${"5".repeat(40)}`;
const SECOND_STABLE_POOL = `0x${"6".repeat(40)}`;

function log(overrides: Partial<Phase1RpcLog>): Phase1RpcLog {
  return {
    address: `0x${"2".repeat(40)}`,
    blockNumber: hex(100),
    blockHash: txHash(100),
    transactionHash: txHash(1),
    logIndex: "0x0",
    topics: [],
    data: "0x",
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    data_sources: {
      robinhood_chain: {
        enabled: true,
        confirmations: 2,
        rpc_urls: ["https://rpc.example"],
        phase1: {
          enabled: true,
          delivery: "shadow",
          initial_backfill_blocks: 5,
          max_log_blocks_per_tick: 5,
          reorg_overlap_blocks: 2,
          min_liquidity_usd: 25_000,
          min_volume_5m_usd: 10_000,
          min_unique_traders: 3,
          ...overrides,
        },
      },
    },
  };
}

describe("Robinhood Chain Phase 1", () => {
  it("keeps shadow delivery and bounded collection settings", () => {
    const resolved = resolveRobinhoodPhase1Config(
      config({
        max_log_blocks_per_tick: 99999,
        catch_up_lag_blocks: 0,
        catch_up_blocks_per_tick: 1,
        provider_cooldown_ms: 99999,
        log_rpc_concurrency: 0,
      }),
    );
    assert.equal(resolved.delivery, "shadow");
    assert.equal(
      (resolveRobinhoodPhase1Config(config({ discovery_source: "gmgn" })) as unknown as Record<string, unknown>)
        .discoverySource,
      "gmgn",
    );
    assert.equal(resolved.maxLogBlocksPerTick, 2000);
    assert.equal(resolved.catchUpLagBlocks, 1000);
    assert.equal(resolved.catchUpBlocksPerTick, 1000);
    assert.equal(resolved.providerCooldownMs, 30_000);
    assert.equal(resolved.maxLogBlocksPerRequest, 500);
    assert.equal(resolved.logRpcConcurrency, 1);
    const defaults = resolveRobinhoodPhase1Config(config());
    assert.equal(defaults.catchUpLagBlocks, 10_000);
    assert.equal(defaults.catchUpBlocksPerTick, 2000);
    assert.equal(defaults.providerCooldownMs, 5000);
    assert.equal(defaults.logRpcConcurrency, 3);
    assert.equal(defaults.backfillCollectSeconds, 300);
    assert.equal(resolveRobinhoodPhase1Config(config({ backfill_collect_seconds: 1 })).backfillCollectSeconds, 30);
    assert.equal(resolved.stablePoolDiscoveryBackfillBlocks, 1_000_000);
    assert.equal(resolved.xEnabled, true);
    assert.equal(resolveRobinhoodPhase1Config(config({ x_enabled: false })).xEnabled, false);
    assert.equal(
      resolveRobinhoodPhase1Config(config({ stable_pool_discovery_backfill_blocks: 9_999 }))
        .stablePoolDiscoveryBackfillBlocks,
      10_000,
    );
    assert.throws(() => resolveRobinhoodPhase1Config(config({ delivery: "telegram" })), /shadow/);
  });

  it("uses the steady-state block budget at the catch-up lag threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-steady-budget-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({ firstBlock: 100, lastBlock: 100, pools: [], events: [], retentionDays: 30, cursor: 100 });
    store.setState("pool_discovery_bootstrap_v1", "1");
    store.close();
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(10_102);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({
        config: config({
          max_log_blocks_per_tick: 1000,
          catch_up_lag_blocks: 10_000,
          catch_up_blocks_per_tick: 2000,
          reorg_overlap_blocks: 20,
        }),
        dbPath,
        transport,
      });
      assert.equal(result.firstBlock, 10096);
      assert.equal(result.lastBlock, 10100);
      assert.equal(result.backfillFirstBlock, 81);
      assert.equal(result.backfillLastBlock, 1080);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the bounded catch-up block budget above the lag threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-catch-up-budget-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({ firstBlock: 100, lastBlock: 100, pools: [], events: [], retentionDays: 30, cursor: 100 });
    store.setState("pool_discovery_bootstrap_v1", "1");
    store.close();
    const creationFilters: Record<string, unknown>[] = [];
    const requestedUrls = new Set<string>();
    const transport: RpcTransport = async (url, method, params) => {
      requestedUrls.add(url);
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(20_102);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        creationFilters.push(params[0] as Record<string, unknown>);
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({
        config: config({
          rpc_urls: ["https://phase1.example"],
          max_log_blocks_per_tick: 1000,
          catch_up_lag_blocks: 10_000,
          catch_up_blocks_per_tick: 2000,
          reorg_overlap_blocks: 20,
        }),
        dbPath,
        transport,
      });
      assert.equal(result.firstBlock, 20096);
      assert.equal(result.lastBlock, 20100);
      assert.equal(result.backfillFirstBlock, 81);
      assert.equal(result.backfillLastBlock, 2080);
      assert.deepEqual([...requestedUrls], ["https://phase1.example"]);
      assert.equal(creationFilters.length, 5);
      assert.equal((creationFilters[0]!.address as string[]).length, 5);
      assert.equal(((creationFilters[0]!.topics as unknown[])[0] as string[]).length, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts realtime coverage without replacing the historical cursor and advances both lanes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-dual-lane-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({ firstBlock: 100, lastBlock: 100, pools: [], events: [], retentionDays: 30, cursor: 100 });
    store.setState("pool_discovery_bootstrap_v1", "1");
    store.close();
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(1000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath, transport });
      const lanes = result as typeof result & Record<string, number | undefined>;
      const migrated = new RobinhoodPhase1Store(dbPath);
      assert.equal(lanes.realtimeFirstBlock, 994);
      assert.equal(lanes.realtimePersistedBlock, 998);
      assert.equal(lanes.backfillFirstBlock, 99);
      assert.equal(lanes.backfillPersistedBlock, 103);
      assert.equal(migrated.getState("realtime_start_block"), "994");
      assert.equal(migrated.getState("realtime_cursor"), "998");
      assert.equal(migrated.getState("backfill_cursor"), "103");
      assert.equal(migrated.getState("last_confirmed_block"), "103");
      assert.equal(migrated.getState("history_complete"), "0");
      migrated.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps realtime Phase 1 healthy when only the historical lane exhausts retries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-backfill-failure-"));
    const dbPath = join(dir, "phase1.sqlite");
    const seed = new RobinhoodPhase1Store(dbPath);
    seed.applyBatch({ firstBlock: 100, lastBlock: 100, pools: [], events: [], retentionDays: 30, cursor: 100 });
    seed.setState("pool_discovery_bootstrap_v1", "1");
    seed.close();
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(1000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        const filter = params[0] as { fromBlock?: string };
        const from = Number.parseInt(String(filter.fromBlock).slice(2), 16);
        if (from < 500) throw new Error("HTTP 429");
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({
        config: config({ log_rpc_concurrency: 1 }),
        dbPath,
        transport,
        sleep: async () => undefined,
      });
      const store = new RobinhoodPhase1Store(dbPath);
      assert.equal(result.status, "persisted");
      assert.equal(result.backfillStatus, "failed");
      assert.equal(store.getState("realtime_cursor"), "998");
      assert.equal(store.getState("last_confirmed_block"), "100");
      assert.equal(store.getHealthStatus(), "ok");
      assert.equal(store.getHealthStatus("robinhood_chain_phase1_backfill"), "error");
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("jumps realtime Phase 1 to the tip and reopens a historical gap after downtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-realtime-gap-"));
    const dbPath = join(dir, "phase1.sqlite");
    const seed = new RobinhoodPhase1Store(dbPath);
    seed.applyBatch({
      firstBlock: 100,
      lastBlock: 100,
      pools: [],
      events: [],
      retentionDays: 30,
      cursor: 100,
      lane: "realtime",
      stateUpdates: {
        realtime_start_block: "96",
        backfill_cursor: "95",
        last_confirmed_block: "100",
        history_complete: "1",
        pool_discovery_bootstrap_v1: "1",
      },
    });
    seed.close();
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(1000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath, transport });
      const reopened = new RobinhoodPhase1Store(dbPath);
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

  it("fails Phase 1 freshness without moving the fixed history boundary during an in-process capacity overrun", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-realtime-capacity-"));
    const dbPath = join(dir, "phase1.sqlite");
    const seed = new RobinhoodPhase1Store(dbPath);
    seed.applyBatch({
      firstBlock: 100,
      lastBlock: 100,
      pools: [],
      events: [],
      retentionDays: 30,
      cursor: 100,
      lane: "realtime",
      stateUpdates: {
        realtime_start_block: "96",
        backfill_cursor: "95",
        last_confirmed_block: "95",
        history_complete: "0",
        pool_discovery_bootstrap_v1: "1",
      },
    });
    seed.close();
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(1000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    };
    try {
      await assert.rejects(
        () =>
          collectRobinhoodPhase1({
            config: config(),
            dbPath,
            transport,
            allowRealtimeRebase: false,
          } as Parameters<typeof collectRobinhoodPhase1>[0]),
        /realtime capacity exceeded/,
      );
      const unchanged = new RobinhoodPhase1Store(dbPath);
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

  it("closes the fixed Phase 1 historical gap and keeps rollback contiguous", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-history-close-"));
    const dbPath = join(dir, "phase1.sqlite");
    const seed = new RobinhoodPhase1Store(dbPath);
    seed.applyBatch({ firstBlock: 95, lastBlock: 95, pools: [], events: [], retentionDays: 30, cursor: 95 });
    seed.setState("pool_discovery_bootstrap_v1", "1");
    seed.close();
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(105);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") return [];
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath, transport });
      const closed = new RobinhoodPhase1Store(dbPath);
      assert.equal(result.historyComplete, true);
      assert.equal(result.backfillStatus, "complete");
      assert.equal(closed.getState("backfill_cursor"), "98");
      assert.equal(closed.getState("last_confirmed_block"), "103");
      assert.equal(closed.getState("history_complete"), "1");
      closed.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ships only bytecode-verified protocol definitions as enabled", () => {
    const enabled = BUILTIN_ROBINHOOD_PROTOCOLS.filter((item) => item.enabled);
    assert.deepEqual(
      enabled.map((item) => item.id),
      ["uniswap_v2", "uniswap_v3", "uniswap_v4", "up_v3", "metric_v1"],
    );
    assert.equal(
      BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v3")?.discoveryAddress,
      "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    );
    for (const item of enabled) {
      assert.match(item.discoveryAddress, /^0x[0-9a-f]{40}$/);
      assert.match(item.creationTopic, /^0x[0-9a-f]{64}$/);
      assert.match(item.swapTopic, /^0x[0-9a-f]{64}$/);
    }
  });

  it("decodes V2 and V4 pool creation logs", () => {
    const v2 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const decodedV2 = decodePoolCreatedLog(
      v2,
      log({
        address: v2.discoveryAddress,
        topics: [v2.creationTopic, topicAddress(TOKEN0), topicAddress(USDG)],
        data: `0x${addressWord(POOL)}${word(1)}`,
      }),
      1_700_000_000,
    );
    assert.equal(decodedV2.poolKey, POOL);
    assert.equal(decodedV2.token1, USDG);

    const v4 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v4")!;
    const poolId = txHash(55);
    const decodedV4 = decodePoolCreatedLog(
      v4,
      log({
        address: v4.discoveryAddress,
        topics: [v4.creationTopic, poolId, topicAddress(TOKEN0), topicAddress(USDG)],
        data: `0x${word(3000)}${word(60)}${addressWord(`0x${"0".repeat(40)}`)}${word(1)}${word(0)}`,
      }),
      1_700_000_000,
    );
    assert.equal(decodedV4.poolKey, poolId);
    assert.equal(decodedV4.executionAddress, v4.discoveryAddress);
  });

  it("derives stablecoin notional from V2 and V3 swaps", () => {
    const v2 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const pool = {
      poolKey: POOL,
      executionAddress: POOL,
      protocolId: v2.id,
      token0: TOKEN0,
      token1: USDG,
      createdBlock: 1,
      createdAt: 1,
      creationEventId: "x",
      quality: "verified" as const,
    };
    const decodedV2 = decodeSwapLog(
      v2,
      pool,
      log({
        address: POOL,
        topics: [v2.swapTopic, topicAddress(TOKEN0), topicAddress(TOKEN0)],
        data: `0x${word(1)}${word(12_500_000_000)}${word(2)}${word(0)}`,
      }),
      1_700_000_000,
      new Map([[USDG, 6]]),
    );
    assert.equal(decodedV2.volumeUsd, 12_500);

    const v3 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v3")!;
    const decodedV3 = decodeSwapLog(
      v3,
      { ...pool, protocolId: v3.id },
      log({
        address: POOL,
        topics: [v3.swapTopic, topicAddress(TOKEN0), topicAddress(TOKEN0)],
        data: `0x${word(1)}${word(25_000_000_000)}${word(1)}${word(1)}${word(1)}`,
      }),
      1_700_000_000,
      new Map([[USDG, 6]]),
    );
    assert.equal(decodedV3.volumeUsd, 25_000);
  });

  it("qualifies only candidates that pass every deterministic gate", () => {
    const qualified = evaluateTrendCandidate({
      volumeUsd: 50_000,
      baselineVolume1hUsd: 10_000,
      baselineVolume24hUsd: 8_000,
      uniqueTraders: 12,
      baselineUniqueTraders1h: 3,
      baselineUniqueTraders24h: 2,
      liquidityUsd: 100_000,
      previousLiquidityUsd: 90_000,
      venueBreadth: 2,
      poolAgeSeconds: 3600,
      pricedSwapCount: 8,
      swapCount: 8,
      verifiedProtocol: true,
      sourceHealthy: true,
      minVolumeUsd: 10_000,
      minLiquidityUsd: 25_000,
      minUniqueTraders: 3,
    });
    assert.equal(qualified.state, "qualified");
    assert.ok(qualified.score > 50);

    const rejected = evaluateTrendCandidate({ ...qualified.input, liquidityUsd: null });
    assert.equal(rejected.state, "rejected");
    assert.ok(rejected.reasons.includes("liquidity_unknown"));
  });

  it("persists idempotent windows and invalidates replaced overlap data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-store-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const pool = {
      poolKey: POOL,
      executionAddress: POOL,
      protocolId: protocol.id,
      token0: TOKEN0,
      token1: USDG,
      createdBlock: 95,
      createdAt: 1_700_000_000,
      creationEventId: "create",
      quality: "verified" as const,
    };
    const event = {
      eventId: "swap:1",
      poolKey: POOL,
      protocolId: protocol.id,
      eventType: "swap" as const,
      blockNumber: 100,
      blockHash: txHash(100),
      transactionHash: txHash(1),
      logIndex: 0,
      timestamp: 1_700_000_100,
      trader: TOKEN0,
      volumeUsd: 20_000,
      liquidityUsd: 80_000,
    };
    try {
      store.applyBatch({ firstBlock: 95, lastBlock: 100, pools: [pool], events: [event], retentionDays: 30 });
      store.applyBatch({ firstBlock: 99, lastBlock: 100, pools: [], events: [event], retentionDays: 30 });
      assert.equal(store.count("dex_events"), 1);
      assert.equal(store.count("pool_windows"), 1);
      const replacement = { ...event, blockHash: txHash(101), volumeUsd: 40_000 };
      store.applyBatch({ firstBlock: 99, lastBlock: 100, pools: [], events: [replacement], retentionDays: 30 });
      assert.equal(store.getWindow(POOL, Math.floor(event.timestamp / 300) * 300)?.volumeUsd, 40_000);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not cascade-delete newer realtime events when historical backfill revisits a pool creation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-backfill-pool-preserve-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const pool = {
      poolKey: POOL,
      executionAddress: POOL,
      protocolId: protocol.id,
      token0: TOKEN0,
      token1: USDG,
      createdBlock: 10,
      createdAt: 1_700_000_000,
      creationEventId: "create:historical",
      quality: "verified" as const,
    };
    const realtimeEvent = {
      eventId: "swap:realtime",
      poolKey: POOL,
      protocolId: protocol.id,
      eventType: "swap" as const,
      blockNumber: 1000,
      blockHash: txHash(1000),
      transactionHash: txHash(1001),
      logIndex: 0,
      timestamp: 1_700_001_000,
      trader: TOKEN0,
      volumeUsd: 20_000,
      liquidityUsd: 80_000,
    };
    try {
      store.applyBatch({
        firstBlock: 1000,
        lastBlock: 1000,
        pools: [pool],
        events: [realtimeEvent],
        retentionDays: 30,
        cursor: 1000,
        lane: "realtime",
      });
      store.applyBatch({
        firstBlock: 10,
        lastBlock: 20,
        pools: [pool],
        events: [],
        retentionDays: 30,
        cursor: 20,
        lane: "backfill",
      });
      assert.equal(store.count("dex_events"), 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps a boundary window realtime when a backfill batch contributes older blocks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-boundary-lane-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const pool = {
      poolKey: POOL,
      executionAddress: POOL,
      protocolId: protocol.id,
      token0: TOKEN0,
      token1: USDG,
      createdBlock: 10,
      createdAt: 1_700_000_000,
      creationEventId: "create:boundary",
      quality: "verified" as const,
    };
    const event = (id: string, blockNumber: number) => ({
      eventId: id,
      poolKey: POOL,
      protocolId: protocol.id,
      eventType: "swap" as const,
      blockNumber,
      blockHash: txHash(blockNumber),
      transactionHash: txHash(blockNumber + 1),
      logIndex: 0,
      timestamp: 1_700_001_000,
      trader: TOKEN0,
      volumeUsd: 20_000,
      liquidityUsd: 80_000,
    });
    const windowStart = Math.floor(1_700_001_000 / 300) * 300;
    try {
      store.setState("realtime_start_block", "1000");
      store.applyBatch({
        firstBlock: 1000,
        lastBlock: 1000,
        pools: [pool],
        events: [event("swap:boundary:rt", 1000)],
        retentionDays: 30,
        cursor: 1000,
        lane: "realtime",
      });
      store.applyBatch({
        firstBlock: 999,
        lastBlock: 999,
        pools: [],
        events: [event("swap:boundary:bf", 999)],
        retentionDays: 30,
        cursor: 999,
        lane: "backfill",
      });
      assert.equal(store.getAuditLane(POOL, windowStart), "realtime");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses strict trailing baselines and order-independent active venue breadth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-baseline-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const v2 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const v3 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v3")!;
    const secondPool = "0x2222222222222222222222222222222222222222";
    const windowStart = Math.floor(1_700_100_000 / 300) * 300;
    const pools = [
      {
        poolKey: POOL,
        executionAddress: POOL,
        protocolId: v2.id,
        token0: TOKEN0,
        token1: USDG,
        createdBlock: 1,
        createdAt: windowStart - 100_000,
        creationEventId: "create:baseline:v2",
        quality: "verified" as const,
      },
      {
        poolKey: secondPool,
        executionAddress: secondPool,
        protocolId: v3.id,
        token0: TOKEN0,
        token1: USDG,
        createdBlock: 1,
        createdAt: windowStart - 100_000,
        creationEventId: "create:baseline:v3",
        quality: "verified" as const,
      },
    ];
    const event = (
      eventId: string,
      poolKey: string,
      protocolId: string,
      blockNumber: number,
      timestamp: number,
      volumeUsd: number,
    ) => ({
      eventId,
      poolKey,
      protocolId,
      eventType: "swap" as const,
      blockNumber,
      blockHash: txHash(blockNumber),
      transactionHash: txHash(blockNumber + 100),
      logIndex: 0,
      timestamp,
      trader: TOKEN0,
      volumeUsd,
      liquidityUsd: 80_000,
    });
    const thresholds = {
      minLiquidityUsd: 25_000,
      minVolume5mUsd: 1,
      minUniqueTraders: 1,
      minTrendScore: 0,
    };
    try {
      store.applyBatch({
        firstBlock: 1,
        lastBlock: 1,
        pools,
        events: [event("old", POOL, v2.id, 1, windowStart - 90_000, 1_000_000)],
        retentionDays: 30,
        thresholds,
      });
      store.applyBatch({
        firstBlock: 2,
        lastBlock: 2,
        pools: [],
        events: [event("recent", POOL, v2.id, 2, windowStart - 200, 10_000)],
        retentionDays: 30,
        thresholds,
      });
      store.applyBatch({
        firstBlock: 3,
        lastBlock: 4,
        pools: [],
        events: [
          event("current:v2", POOL, v2.id, 3, windowStart + 100, 50_000),
          event("current:v3", secondPool, v3.id, 4, windowStart + 100, 5_000),
        ],
        retentionDays: 30,
        thresholds,
      });
      const candidate = store.getCandidate(POOL, windowStart);
      assert.equal(candidate?.evidence.baselineVolume1hUsd, 10_000);
      assert.equal(candidate?.evidence.baselineVolume24hUsd, 10_000);
      assert.equal(candidate?.evidence.venueBreadth, 2);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stales qualified candidates, retains audit history, and never regresses the cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-stale-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const windowStart = Math.floor(1_700_000_100 / 300) * 300;
    const pool = {
      poolKey: POOL,
      executionAddress: POOL,
      protocolId: protocol.id,
      token0: TOKEN0,
      token1: USDG,
      createdBlock: 95,
      createdAt: windowStart,
      creationEventId: "create:stale",
      quality: "verified" as const,
    };
    const event = {
      eventId: "swap:stale",
      poolKey: POOL,
      protocolId: protocol.id,
      eventType: "swap" as const,
      blockNumber: 100,
      blockHash: txHash(100),
      transactionHash: txHash(101),
      logIndex: 0,
      timestamp: windowStart + 100,
      trader: TOKEN0,
      volumeUsd: 20_000,
      liquidityUsd: 80_000,
    };
    try {
      store.applyBatch({
        firstBlock: 95,
        lastBlock: 100,
        pools: [pool],
        events: [event],
        retentionDays: 30,
        cursor: 100,
        thresholds: { minLiquidityUsd: 1, minVolume5mUsd: 1, minUniqueTraders: 1, minTrendScore: 0 },
      });
      assert.equal(store.getCandidate(POOL, windowStart)?.state, "qualified");
      assert.equal(store.count("signal_audit"), 1);
      store.markQualifiedCandidatesStale("source_health_error");
      assert.equal(store.getCandidate(POOL, windowStart)?.state, "stale");
      assert.equal(store.count("signal_audit"), 1);
      store.applyBatch({ firstBlock: 90, lastBlock: 90, pools: [], events: [], retentionDays: 30, cursor: 90 });
      assert.equal(store.getState("last_confirmed_block"), "100");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prunes rejected candidates after seven days and audit rows after configured retention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-retention-"));
    const dbPath = join(dir, "phase1.sqlite");
    const store = new RobinhoodPhase1Store(dbPath);
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const secondPool = "0x2222222222222222222222222222222222222222";
    const firstStart = Math.floor(1_700_000_100 / 300) * 300;
    const pools = [
      {
        poolKey: POOL,
        executionAddress: POOL,
        protocolId: protocol.id,
        token0: TOKEN0,
        token1: USDG,
        createdBlock: 1,
        createdAt: firstStart,
        creationEventId: "create:retention:first",
        quality: "verified" as const,
      },
      {
        poolKey: secondPool,
        executionAddress: secondPool,
        protocolId: protocol.id,
        token0: TOKEN0,
        token1: USDG,
        createdBlock: 1,
        createdAt: firstStart,
        creationEventId: "create:retention:second",
        quality: "verified" as const,
      },
    ];
    const event = (eventId: string, poolKey: string, blockNumber: number, timestamp: number) => ({
      eventId,
      poolKey,
      protocolId: protocol.id,
      eventType: "swap" as const,
      blockNumber,
      blockHash: txHash(blockNumber),
      transactionHash: txHash(blockNumber + 100),
      logIndex: 0,
      timestamp,
      trader: TOKEN0,
      volumeUsd: 20_000,
      liquidityUsd: 80_000,
    });
    try {
      store.applyBatch({
        firstBlock: 1,
        lastBlock: 1,
        pools,
        events: [event("retention:first", POOL, 1, firstStart + 100)],
        retentionDays: 30,
      });
      assert.equal(store.getCandidate(POOL, firstStart)?.state, "rejected");
      assert.equal(store.hasAudit(POOL, firstStart), true);

      const eightDaysLater = firstStart + 8 * 86400;
      store.applyBatch({
        firstBlock: 2,
        lastBlock: 2,
        pools: [],
        events: [event("retention:second", secondPool, 2, eightDaysLater + 100)],
        retentionDays: 30,
      });
      assert.equal(store.getCandidate(POOL, firstStart), null);
      assert.equal(store.hasAudit(POOL, firstStart), true);

      const thirtyOneDaysLater = firstStart + 31 * 86400;
      store.applyBatch({
        firstBlock: 3,
        lastBlock: 3,
        pools: [],
        events: [event("retention:third", secondPool, 3, thirtyOneDaysLater + 100)],
        retentionDays: 30,
      });
      assert.equal(store.hasAudit(POOL, firstStart), false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not create a Phase 1 database while disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-disabled-"));
    const dbPath = join(dir, "phase1.sqlite");
    try {
      const result = await collectRobinhoodPhase1({ config: {}, dbPath });
      assert.equal(result.status, "disabled");
      await assert.rejects(() => access(dbPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("collects a bounded shadow batch without Telegram or LLM dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-collect-"));
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const calls: string[] = [];
    const transport: RpcTransport = async (_url, method, params) => {
      calls.push(method);
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getBlockByNumber") {
        const number = Number.parseInt(String(params[0]).slice(2), 16);
        return { number: hex(number), timestamp: hex(1_700_000_000 + number), hash: txHash(number) };
      }
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const topics = filter.topics as unknown[];
        if (
          Array.isArray(filter.address) &&
          filter.address.includes(protocol.discoveryAddress) &&
          Array.isArray(topics[0]) &&
          topics[0].includes(protocol.creationTopic)
        ) {
          return [
            log({
              address: protocol.discoveryAddress,
              blockNumber: hex(106),
              blockHash: txHash(106),
              topics: [protocol.creationTopic, topicAddress(TOKEN0), topicAddress(USDG)],
              data: `0x${addressWord(POOL)}${word(1)}`,
            }),
          ];
        }
        if (topics[0] === protocol.creationTopic) {
          return [
            log({
              address: protocol.discoveryAddress,
              blockNumber: hex(106),
              blockHash: txHash(106),
              topics: [protocol.creationTopic, topicAddress(TOKEN0), topicAddress(USDG)],
              data: `0x${addressWord(POOL)}${word(1)}`,
            }),
          ];
        }
        if (Array.isArray(topics[0])) return [];
        return [];
      }
      if (method === "eth_call") return `0x${word(80_000_000)}`;
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath: join(dir, "phase1.sqlite"), transport });
      assert.equal(result.status, "persisted");
      assert.equal(result.delivery, "shadow");
      assert.equal(result.firstBlock, 104);
      assert.equal(result.lastBlock, 108);
      assert.equal(result.poolsDiscovered, 1);
      assert.ok(calls.includes("eth_getLogs"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries rate-limited log RPCs and splits oversized block ranges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-rate-limit-"));
    const ranges: Array<[number, number]> = [];
    let firstLogAttempt = true;
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(2500);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const from = Number.parseInt(String(filter.fromBlock).slice(2), 16);
        const to = Number.parseInt(String(filter.toBlock).slice(2), 16);
        ranges.push([from, to]);
        if (firstLogAttempt) {
          firstLogAttempt = false;
          throw new Error("HTTP 429");
        }
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({
        config: config({
          initial_backfill_blocks: 2000,
          max_log_blocks_per_tick: 2000,
          max_log_blocks_per_request: 1000,
        }),
        dbPath: join(dir, "phase1.sqlite"),
        transport,
        sleep: async () => undefined,
      });
      assert.equal(result.status, "persisted");
      assert.ok(ranges.length > 2);
      assert.ok(ranges.every(([from, to]) => to - from + 1 <= 1000));
      assert.deepEqual(ranges[0], ranges[1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries transient validation, latest-block, timestamp, and liquidity reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-read-retry-"));
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const attempts = new Map<string, number>();
    const transport: RpcTransport = async (_url, method, params) => {
      const count = (attempts.get(method) ?? 0) + 1;
      attempts.set(method, count);
      if (["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_call"].includes(method) && count === 1) {
        throw new Error("HTTP 429");
      }
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getBlockByNumber") {
        const number = Number.parseInt(String(params[0]).slice(2), 16);
        return { number: hex(number), timestamp: hex(1_700_000_000 + number), hash: txHash(number) };
      }
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const topics = filter.topics as unknown[];
        if (topics[0] === protocol.creationTopic) {
          return [
            log({
              address: protocol.discoveryAddress,
              blockNumber: hex(106),
              blockHash: txHash(106),
              topics: [protocol.creationTopic, topicAddress(TOKEN0), topicAddress(USDG)],
              data: `0x${addressWord(POOL)}${word(1)}`,
            }),
          ];
        }
        if (topics[0] === protocol.swapTopic || (Array.isArray(topics[0]) && topics[0].includes(protocol.swapTopic))) {
          return [
            log({
              address: POOL,
              blockNumber: hex(107),
              blockHash: txHash(107),
              transactionHash: txHash(7),
              topics: [protocol.swapTopic, topicAddress(TOKEN0), topicAddress(TOKEN0)],
              data: `0x${word(1)}${word(12_500_000_000)}${word(2)}${word(0)}`,
            }),
          ];
        }
        return [];
      }
      if (method === "eth_call") return `0x${word(80_000_000)}`;
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({
        config: config(),
        dbPath: join(dir, "phase1.sqlite"),
        transport,
        sleep: async () => undefined,
      });
      assert.equal(result.status, "persisted");
      assert.equal(attempts.get("eth_chainId"), 2);
      assert.equal(attempts.get("eth_blockNumber"), 2);
      assert.ok((attempts.get("eth_getBlockByNumber") ?? 0) >= 2);
      assert.equal(attempts.get("eth_call"), 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("polls swaps only for stablecoin-eligible pools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-stable-pools-"));
    const dbPath = join(dir, "phase1.sqlite");
    const protocol = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v2")!;
    const v3 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v3")!;
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({
      firstBlock: 1,
      lastBlock: 2,
      pools: [
        {
          poolKey: POOL,
          executionAddress: POOL,
          protocolId: protocol.id,
          token0: TOKEN0,
          token1: USDG,
          createdBlock: 1,
          createdAt: 1_700_000_000,
          creationEventId: "stable-create",
          quality: "verified",
        },
        {
          poolKey: SECOND_STABLE_POOL,
          executionAddress: SECOND_STABLE_POOL,
          protocolId: v3.id,
          token0: USDG,
          token1: TOKEN1,
          createdBlock: 2,
          createdAt: 1_700_000_001,
          creationEventId: "second-stable-create",
          quality: "verified",
        },
        {
          poolKey: NON_STABLE_POOL,
          executionAddress: NON_STABLE_POOL,
          protocolId: protocol.id,
          token0: TOKEN0,
          token1: TOKEN1,
          createdBlock: 2,
          createdAt: 1_700_000_001,
          creationEventId: "non-stable-create",
          quality: "verified",
        },
      ],
      events: [],
      retentionDays: 30,
      cursor: 2,
    });
    store.setState("pool_discovery_bootstrap_v1", "1");
    store.close();
    const swapFilters: Record<string, unknown>[] = [];
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        if (Array.isArray(filter.address) && filter.address.includes(POOL)) {
          swapFilters.push(filter);
        }
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath, transport });
      assert.equal(result.status, "persisted");
      assert.equal(swapFilters.length, 2);
      for (const filter of swapFilters) {
        assert.deepEqual(filter.address, [POOL, SECOND_STABLE_POOL]);
        assert.deepEqual((filter.topics as unknown[])[0], [protocol.swapTopic, v3.swapTopic]);
        assert.equal((filter.address as string[]).includes(NON_STABLE_POOL), false);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("queries V4 swaps once per block chunk and retains only known stablecoin pools", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-v4-topic-scan-"));
    const dbPath = join(dir, "phase1.sqlite");
    const v4 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v4")!;
    const stablePoolKey = txHash(55);
    const nonStablePoolKey = txHash(56);
    const unknownPoolKey = txHash(59);
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({
      firstBlock: 1,
      lastBlock: 2,
      pools: [
        {
          poolKey: stablePoolKey,
          executionAddress: v4.discoveryAddress,
          protocolId: v4.id,
          token0: TOKEN0,
          token1: USDG,
          createdBlock: 1,
          createdAt: 1_700_000_000,
          creationEventId: "v4-stable-create",
          quality: "verified",
        },
        {
          poolKey: nonStablePoolKey,
          executionAddress: v4.discoveryAddress,
          protocolId: v4.id,
          token0: TOKEN0,
          token1: TOKEN1,
          createdBlock: 2,
          createdAt: 1_700_000_001,
          creationEventId: "v4-non-stable-create",
          quality: "verified",
        },
      ],
      events: [],
      retentionDays: 30,
      cursor: 2,
    });
    store.setState("pool_discovery_bootstrap_v1", "1");
    store.setState("last_backfill_at", String(Math.floor(Date.now() / 1000)));
    store.close();
    const v4SwapFilters: Record<string, unknown>[] = [];
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getBlockByNumber") {
        const number = Number.parseInt(String(params[0]).slice(2), 16);
        return { number: hex(number), timestamp: hex(1_700_000_000 + number), hash: txHash(number) };
      }
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const topics = filter.topics as unknown[];
        if (filter.address === v4.discoveryAddress && topics[0] === v4.swapTopic) {
          v4SwapFilters.push(filter);
          return [
            log({
              address: v4.discoveryAddress,
              blockNumber: hex(107),
              blockHash: txHash(107),
              transactionHash: txHash(70),
              logIndex: "0x0",
              topics: [v4.swapTopic, stablePoolKey, topicAddress(TOKEN0)],
              data: `0x${word(1)}${word(25_000_000)}${word(1)}${word(1)}${word(1)}`,
            }),
            log({
              address: v4.discoveryAddress,
              blockNumber: hex(108),
              blockHash: txHash(108),
              transactionHash: txHash(71),
              logIndex: "0x0",
              topics: [v4.swapTopic, nonStablePoolKey, topicAddress(TOKEN0)],
              data: `0x${word(1)}${word(30_000_000)}${word(1)}${word(1)}${word(1)}`,
            }),
            log({
              address: v4.discoveryAddress,
              blockNumber: hex(109),
              blockHash: txHash(109),
              transactionHash: txHash(73),
              logIndex: "0x0",
              topics: [v4.swapTopic, unknownPoolKey, topicAddress(TOKEN0)],
              data: `0x${word(1)}${word(35_000_000)}${word(1)}${word(1)}${word(1)}`,
            }),
          ];
        }
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const result = await collectRobinhoodPhase1({ config: config(), dbPath, transport });
      assert.equal(result.status, "persisted");
      assert.equal(result.swapsObserved, 1);
      assert.equal(v4SwapFilters.length, 1);
      assert.deepEqual(v4SwapFilters[0]!.topics, [v4.swapTopic]);
      const persisted = new RobinhoodPhase1Store(dbPath);
      assert.equal(persisted.count("dex_events"), 1);
      persisted.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed V4 response without advancing realtime or history state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-v4-malformed-"));
    const dbPath = join(dir, "phase1.sqlite");
    const v4 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v4")!;
    const stablePoolKey = txHash(57);
    const store = new RobinhoodPhase1Store(dbPath);
    store.applyBatch({
      firstBlock: 1,
      lastBlock: 2,
      pools: [
        {
          poolKey: stablePoolKey,
          executionAddress: v4.discoveryAddress,
          protocolId: v4.id,
          token0: TOKEN0,
          token1: USDG,
          createdBlock: 1,
          createdAt: 1_700_000_000,
          creationEventId: "v4-malformed-create",
          quality: "verified",
        },
      ],
      events: [],
      retentionDays: 30,
      cursor: 2,
      lane: "realtime",
      stateUpdates: {
        realtime_start_block: "1",
        backfill_cursor: "0",
        last_confirmed_block: "0",
        history_complete: "0",
        pool_discovery_bootstrap_v1: "1",
        last_backfill_at: String(Math.floor(Date.now() / 1000)),
      },
    });
    store.close();
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const topics = filter.topics as unknown[];
        if (filter.address === v4.discoveryAddress && topics[0] === v4.swapTopic) {
          return [
            log({
              address: POOL,
              blockNumber: hex(107),
              blockHash: txHash(107),
              transactionHash: txHash(72),
              logIndex: "0x0",
              topics: [v4.swapTopic, stablePoolKey, topicAddress(TOKEN0)],
              data: `0x${word(1)}${word(25_000_000)}${word(1)}${word(1)}${word(1)}`,
            }),
          ];
        }
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      await assert.rejects(
        () => collectRobinhoodPhase1({ config: config(), dbPath, transport }),
        /V4 swap log does not match the requested PoolManager and topic/,
      );
      const unchanged = new RobinhoodPhase1Store(dbPath);
      assert.equal(unchanged.getState("realtime_start_block"), "1");
      assert.equal(unchanged.getState("realtime_cursor"), "2");
      assert.equal(unchanged.getState("backfill_cursor"), "0");
      assert.equal(unchanged.getState("history_complete"), "0");
      assert.equal(unchanged.getHealthStatus(), "error");
      assert.equal(unchanged.count("dex_events"), 0);
      unchanged.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cursor unchanged when bounded log retries are exhausted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-rate-limit-fail-"));
    const dbPath = join(dir, "phase1.sqlite");
    let logAttempts = 0;
    const transport: RpcTransport = async (_url, method) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(110);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        logAttempts += 1;
        throw new Error("HTTP 429");
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      await assert.rejects(
        () =>
          collectRobinhoodPhase1({
            config: config({ log_rpc_concurrency: 1 }),
            dbPath,
            transport,
            sleep: async () => undefined,
          }),
        /HTTP 429/,
      );
      assert.equal(logAttempts, 3);
      const store = new RobinhoodPhase1Store(dbPath);
      assert.equal(store.getState("last_confirmed_block"), null);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bootstraps stablecoin pool discovery once while keeping swaps on the normal range", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-bootstrap-"));
    const dbPath = join(dir, "phase1.sqlite");
    const v3 = BUILTIN_ROBINHOOD_PROTOCOLS.find((item) => item.id === "uniswap_v3")!;
    const logFilters: Array<Record<string, unknown>> = [];
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(20_000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getBlockByNumber") {
        const number = Number.parseInt(String(params[0]).slice(2), 16);
        return { number: hex(number), timestamp: hex(1_700_000_000 + number), hash: txHash(number) };
      }
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        logFilters.push(filter);
        const topics = filter.topics as Array<string | string[] | null>;
        if (filter.address === v3.discoveryAddress && topics[0] === v3.creationTopic && Array.isArray(topics[2])) {
          return [
            log({
              address: v3.discoveryAddress,
              blockNumber: hex(10_000),
              blockHash: txHash(10_000),
              topics: [v3.creationTopic, topicAddress(TOKEN0), topicAddress(USDG), `0x${word(3000)}`],
              data: `0x${word(60)}${addressWord(POOL)}`,
            }),
          ];
        }
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      const bootstrapConfig = config({ stable_pool_discovery_backfill_blocks: 10_000 });
      const first = await collectRobinhoodPhase1({ config: bootstrapConfig, dbPath, transport });
      assert.equal(first.status, "persisted");

      const historicalCreations = logFilters.filter((filter) => {
        const topics = filter.topics as Array<string | string[] | null>;
        return filter.address === v3.discoveryAddress && topics[0] === v3.creationTopic && Array.isArray(topics[2]);
      });
      assert.ok(historicalCreations.length > 1);
      assert.equal(historicalCreations[0]?.fromBlock, hex(9_999));
      assert.equal(historicalCreations.at(-1)?.toBlock, hex(19_998));
      assert.ok(
        historicalCreations.every((filter) => {
          const from = Number.parseInt(String(filter.fromBlock).slice(2), 16);
          const to = Number.parseInt(String(filter.toBlock).slice(2), 16);
          return to - from + 1 <= 500;
        }),
      );
      assert.deepEqual((historicalCreations[0]!.topics as unknown[])[2], [
        topicAddress(USDG),
        topicAddress("0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34"),
      ]);

      const swapFilter = logFilters.find((filter) => {
        const topics = filter.topics as Array<string | string[] | null>;
        return (
          Array.isArray(filter.address) &&
          (topics[0] === v3.swapTopic || (Array.isArray(topics[0]) && topics[0].includes(v3.swapTopic)))
        );
      });
      assert.equal(swapFilter?.fromBlock, hex(19_994));
      assert.equal(swapFilter?.toBlock, hex(19_998));

      const store = new RobinhoodPhase1Store(dbPath);
      assert.equal(store.getState("pool_discovery_bootstrap_v1"), "1");
      assert.equal(store.getPools(v3.id).length, 1);
      store.close();

      logFilters.length = 0;
      await collectRobinhoodPhase1({ config: bootstrapConfig, dbPath, transport });
      assert.equal(
        logFilters.some((filter) => {
          const topics = filter.topics as Array<string | string[] | null>;
          return topics.slice(1).some((topic) => Array.isArray(topic));
        }),
        false,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not mark stablecoin discovery bootstrap complete when a historical query fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-bootstrap-fail-"));
    const dbPath = join(dir, "phase1.sqlite");
    const transport: RpcTransport = async (_url, method, params) => {
      if (method === "eth_chainId") return hex(4663);
      if (method === "eth_blockNumber") return hex(20_000);
      if (method === "eth_getCode") return "0x6000";
      if (method === "eth_getLogs") {
        const filter = params[0] as Record<string, unknown>;
        const topics = filter.topics as Array<string | string[] | null>;
        if (topics.slice(1).some((topic) => Array.isArray(topic))) throw new Error("historical log range unavailable");
        return [];
      }
      throw new Error(`unexpected ${method}`);
    };
    try {
      await assert.rejects(
        () =>
          collectRobinhoodPhase1({
            config: config({ stable_pool_discovery_backfill_blocks: 10_000 }),
            dbPath,
            transport,
          }),
        /historical log range unavailable/,
      );
      const store = new RobinhoodPhase1Store(dbPath);
      assert.equal(store.getState("pool_discovery_bootstrap_v1"), null);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("isolates Phase 1 collector failures from the daemon scheduler", async () => {
    const lines: string[] = [];
    let permission: boolean | undefined;
    await runRobinhoodPhase1CollectorJob(
      config(),
      async (options) => {
        permission = options.allowRealtimeRebase;
        throw new Error("log RPC offline");
      },
      (line) => lines.push(line),
      false,
    );
    assert.equal(permission, false);
    assert.deepEqual(lines, ["[robinhood-phase1] failed: log RPC offline"]);
  });

  it("stores explicit X account observations without creating chain signals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "king-ai-rh-p1-x-"));
    const dbPath = join(dir, "phase1.sqlite");
    try {
      const result = await collectRobinhoodPhase1Accounts({
        config: config({ x_enabled: true, x_max_accounts: 2, x_accounts: ["RobinhoodCrypto", "Custom_RH"] }),
        dbPath,
        fetcher: async (handle) =>
          handle === "RobinhoodCrypto"
            ? [{ id: "123", text: "Robinhood Chain update", url: "https://x.com/i/status/123", created_at: "now" }]
            : [],
      });
      assert.equal(result.accountsChecked, 2);
      assert.equal(result.postsObserved, 1);
      assert.deepEqual(result.health, { ok: 1, no_results: 1 });
      const store = new RobinhoodPhase1Store(dbPath);
      assert.equal(store.count("trend_candidates"), 0);
      store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
