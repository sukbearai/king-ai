import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRADE_STATE_DIR } from "../paths.js";
import { loadTradeConfig, type TradeConfig } from "./config.js";
import { acquireDaemonPidLock, type PidLockHandle } from "./pid-lock.js";
import {
  collectRobinhoodChain,
  resolveRobinhoodChainConfig,
  sanitizeRpcUrl,
  type RobinhoodCollectionResult,
} from "./robinhood-chain.js";
import {
  collectRobinhoodPhase1,
  collectRobinhoodPhase1Accounts,
  resolveRobinhoodPhase1Config,
  type RobinhoodPhase1Result,
  type RobinhoodPhase1XResult,
} from "./robinhood-chain-phase1.js";
import { collectRobinhoodGmgn, type RobinhoodGmgnResult } from "./robinhood-chain-gmgn.js";
import {
  collectRobinhoodPhase2,
  deliverRobinhoodPhase2Telegram,
  resolveRobinhoodPhase2Config,
  type RobinhoodPhase2Result,
  type RobinhoodPhase2TelegramDeliveryResult,
} from "./robinhood-chain-phase2.js";

export interface RobinhoodShadowCycleResult {
  phase0: { status: "ok" | "failed" | "skipped"; result?: RobinhoodCollectionResult; error?: string };
  phase1: {
    status: "ok" | "failed" | "skipped";
    result?: RobinhoodPhase1Result | RobinhoodGmgnResult;
    error?: string;
  };
  phase2: { status: "ok" | "failed" | "skipped"; result?: RobinhoodPhase2Result; error?: string };
  telegram: {
    status: "ok" | "failed" | "skipped";
    result?: RobinhoodPhase2TelegramDeliveryResult;
    error?: string;
  };
}

export interface RobinhoodShadowScheduleState {
  lastPhase0: number;
  lastPhase1: number;
  lastPhase1X: number;
  lastPhase2: number;
}

export interface RobinhoodShadowXRunner {
  start(): boolean;
  drain(): Promise<void>;
}

export interface RobinhoodShadowDaemonOptions {
  config?: TradeConfig;
  intervalSeconds?: number;
  runOnce?: boolean;
  phase0DbPath?: string;
  phase1DbPath?: string;
  gmgnDbPath?: string;
  phase2DbPath?: string;
  pidPath?: string;
  now?: () => number;
  signal?: AbortSignal;
  wait?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  onStatus?: (line: string) => void;
  collectors?: {
    phase0?: (options: {
      config: TradeConfig;
      dbPath: string;
      allowRealtimeRebase?: boolean;
    }) => Promise<RobinhoodCollectionResult>;
    phase1?: (options: {
      config: TradeConfig;
      dbPath: string;
      allowRealtimeRebase?: boolean;
    }) => Promise<RobinhoodPhase1Result>;
    gmgn?: (options: { config: TradeConfig; dbPath: string; signal?: AbortSignal }) => Promise<RobinhoodGmgnResult>;
    phase1X?: (options: { config: TradeConfig; dbPath: string }) => Promise<RobinhoodPhase1XResult>;
    phase2?: (options: {
      config: TradeConfig;
      phase1DbPath: string;
      gmgnDbPath?: string;
      phase2DbPath: string;
    }) => Promise<RobinhoodPhase2Result>;
    phase2Telegram?: (options: {
      config: TradeConfig;
      phase2DbPath: string;
      signal?: AbortSignal;
    }) => Promise<RobinhoodPhase2TelegramDeliveryResult>;
  };
}

async function waitForProviderCooldown(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return !signal?.aborted;
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout | null = setTimeout(() => {
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DEFAULT_INTERVAL_SECONDS = 30;

function boundedInterval(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(86400, Math.max(30, Math.trunc(value!)));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function rpcEndpointSetsDisjoint(left: string[], right: string[]): boolean {
  const leftKeys = new Set(left.map(sanitizeRpcUrl));
  return right.every((url) => !leftKeys.has(sanitizeRpcUrl(url)));
}

function defaultPaths() {
  return {
    phase0DbPath: join(TRADE_STATE_DIR, "robinhood_chain.sqlite"),
    phase1DbPath: join(TRADE_STATE_DIR, "robinhood_chain_phase1.sqlite"),
    gmgnDbPath: join(TRADE_STATE_DIR, "robinhood_chain_gmgn.sqlite"),
    phase2DbPath: join(TRADE_STATE_DIR, "robinhood_chain_phase2.sqlite"),
    pidPath: join(TRADE_STATE_DIR, "robinhood-shadow.pid"),
  };
}

export async function runRobinhoodShadowCycle(
  options: Required<Pick<RobinhoodShadowDaemonOptions, "config" | "phase0DbPath" | "phase1DbPath" | "phase2DbPath">> &
    Pick<RobinhoodShadowDaemonOptions, "onStatus" | "collectors"> & {
      stages?: { phase0: boolean; phase1: boolean; phase2: boolean };
      rebasePermissions?: { phase0: boolean; phase1: boolean };
      signal?: AbortSignal;
      gmgnDbPath?: string;
      wait?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
    },
): Promise<RobinhoodShadowCycleResult> {
  const onStatus = options.onStatus ?? (() => undefined);
  const stages = options.stages ?? { phase0: true, phase1: true, phase2: true };
  const signal = options.signal;
  const phase0Config = resolveRobinhoodChainConfig(options.config);
  const phase1Config = resolveRobinhoodPhase1Config(options.config);
  const wait = options.wait ?? waitForProviderCooldown;
  const phase0Collector = options.collectors?.phase0 ?? ((input) => collectRobinhoodChain(input));
  const phase1Collector = options.collectors?.phase1 ?? ((input) => collectRobinhoodPhase1(input));
  const gmgnCollector = options.collectors?.gmgn ?? ((input) => collectRobinhoodGmgn(input));
  const phase2Collector =
    options.collectors?.phase2 ??
    ((input) =>
      collectRobinhoodPhase2({
        config: input.config,
        phase1DbPath: input.phase1DbPath,
        gmgnDbPath: input.gmgnDbPath,
        phase2DbPath: input.phase2DbPath,
      }));
  const phase2TelegramCollector =
    options.collectors?.phase2Telegram ?? ((input) => deliverRobinhoodPhase2Telegram(input));

  const result: RobinhoodShadowCycleResult = {
    phase0: { status: "skipped" },
    phase1: { status: "skipped" },
    phase2: { status: "skipped" },
    telegram: { status: "skipped" },
  };

  const runTelegramDelivery = async () => {
    if (
      signal?.aborted ||
      result.phase2.status !== "ok" ||
      result.phase2.result?.status !== "persisted" ||
      result.phase2.result.delivery !== "telegram"
    ) {
      return;
    }
    try {
      const telegram = await phase2TelegramCollector({
        config: options.config,
        phase2DbPath: options.phase2DbPath,
        signal,
      });
      result.telegram = {
        status: "ok",
        result: telegram,
      };
      onStatus(
        `[robinhood-shadow] telegram ${telegram.status} sent=${telegram.sent} retry=${telegram.retryWait} unknown=${telegram.unknown} cooldown=${telegram.suppressedCooldown} oversized=${telegram.oversized}`,
      );
    } catch (error) {
      result.telegram = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] telegram failed: ${result.telegram.error}`);
    }
  };

  if (phase1Config.discoverySource === "gmgn") {
    if (stages.phase1 && !signal?.aborted) {
      try {
        result.phase1 = {
          status: "ok",
          result: await gmgnCollector({
            config: options.config,
            dbPath: options.gmgnDbPath ?? join(TRADE_STATE_DIR, "robinhood_chain_gmgn.sqlite"),
            signal,
          }),
        };
        const gmgn = result.phase1.result as RobinhoodGmgnResult;
        onStatus(
          `[robinhood-shadow] gmgn ${gmgn.status} observations=${gmgn.observationsPersisted} qualified=${gmgn.candidatesQualified} verified=${gmgn.candidatesVerified}`,
        );
      } catch (error) {
        result.phase1 = { status: "failed", error: boundedError(error) };
        onStatus(`[robinhood-shadow] gmgn failed: ${result.phase1.error}`);
      }
    }
    if (stages.phase2 && !signal?.aborted) {
      try {
        result.phase2 = {
          status: "ok",
          result: await phase2Collector({
            config: options.config,
            phase1DbPath: options.phase1DbPath,
            gmgnDbPath: options.gmgnDbPath,
            phase2DbPath: options.phase2DbPath,
          }),
        };
        onStatus(
          `[robinhood-shadow] phase2 ${result.phase2.result?.status ?? "ok"} readiness=${result.phase2.result?.readiness?.state ?? "-"}`,
        );
      } catch (error) {
        result.phase2 = { status: "failed", error: boundedError(error) };
        onStatus(`[robinhood-shadow] phase2 failed: ${result.phase2.error}`);
      }
      await runTelegramDelivery();
    }
    return result;
  }

  const runPhase0 = async () => {
    if (!stages.phase0 || signal?.aborted) return;
    try {
      result.phase0 = {
        status: "ok",
        result: await phase0Collector({
          config: options.config,
          dbPath: options.phase0DbPath,
          allowRealtimeRebase: options.rebasePermissions?.phase0 ?? true,
        }),
      };
      onStatus(
        `[robinhood-shadow] phase0 ${result.phase0.result?.status ?? "ok"} realtime=${result.phase0.result?.realtimePersistedBlock ?? result.phase0.result?.persistedBlock ?? "-"} backfill=${result.phase0.result?.backfillPersistedBlock ?? "-"}/${result.phase0.result?.backfillTargetBlock ?? "-"} historyComplete=${result.phase0.result?.historyComplete ?? "-"}`,
      );
    } catch (error) {
      result.phase0 = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] phase0 failed: ${result.phase0.error}`);
    }
  };

  const runPhase1 = async () => {
    if (!stages.phase1 || signal?.aborted) return;
    try {
      result.phase1 = {
        status: "ok",
        result: await phase1Collector({
          config: options.config,
          dbPath: options.phase1DbPath,
          allowRealtimeRebase: options.rebasePermissions?.phase1 ?? true,
        }),
      };
      const phase1Result = result.phase1.result as RobinhoodPhase1Result;
      onStatus(
        `[robinhood-shadow] phase1 ${phase1Result.status ?? "ok"} realtime=${phase1Result.realtimePersistedBlock ?? phase1Result.persistedBlock ?? "-"} backfill=${phase1Result.backfillPersistedBlock ?? "-"}/${phase1Result.backfillTargetBlock ?? "-"} historyComplete=${phase1Result.historyComplete ?? "-"}`,
      );
    } catch (error) {
      result.phase1 = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] phase1 failed: ${result.phase1.error}`);
    }
  };

  const parallelChainStages =
    stages.phase0 && stages.phase1 && rpcEndpointSetsDisjoint(phase0Config.rpcUrls, phase1Config.rpcUrls);
  if (parallelChainStages) {
    onStatus("[robinhood-shadow] chain stages parallel rpcSets=disjoint");
    await Promise.all([runPhase0(), runPhase1()]);
  } else {
    await runPhase0();
    if (stages.phase1 && stages.phase0 && phase1Config.providerCooldownMs > 0) {
      onStatus(`[robinhood-shadow] provider cooldown ${phase1Config.providerCooldownMs}ms`);
      const cooled = await wait(phase1Config.providerCooldownMs, signal);
      if (!cooled) {
        onStatus("[robinhood-shadow] provider cooldown interrupted");
        return result;
      }
    }
    await runPhase1();
  }

  if (stages.phase2 && !signal?.aborted) {
    try {
      result.phase2 = {
        status: "ok",
        result: await phase2Collector({
          config: options.config,
          phase1DbPath: options.phase1DbPath,
          gmgnDbPath: options.gmgnDbPath,
          phase2DbPath: options.phase2DbPath,
        }),
      };
      onStatus(
        `[robinhood-shadow] phase2 ${result.phase2.result?.status ?? "ok"} readiness=${result.phase2.result?.readiness?.state ?? "-"}`,
      );
    } catch (error) {
      result.phase2 = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] phase2 failed: ${result.phase2.error}`);
    }
    await runTelegramDelivery();
  }

  return result;
}

export function dueRobinhoodShadowStages(
  now: number,
  state: RobinhoodShadowScheduleState,
  intervals: { phase0: number; phase1: number; phase2: number },
): { phase0: boolean; phase1: boolean; phase2: boolean } {
  return {
    phase0: now - state.lastPhase0 >= intervals.phase0,
    phase1: now - state.lastPhase1 >= intervals.phase1,
    phase2: now - state.lastPhase2 >= intervals.phase2,
  };
}

export function dueRobinhoodShadowX(now: number, lastRun: number, interval: number): boolean {
  return now - lastRun >= interval;
}

export function createRobinhoodShadowXRunner(run: () => Promise<void>): RobinhoodShadowXRunner {
  let inFlight: Promise<void> | null = null;
  return {
    start() {
      if (inFlight) return false;
      const task = Promise.resolve().then(run);
      const tracked = task.finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
      inFlight = tracked;
      return true;
    },
    drain() {
      return inFlight ?? Promise.resolve();
    },
  };
}

export async function runRobinhoodShadowDaemon(options: RobinhoodShadowDaemonOptions = {}): Promise<void> {
  const paths = defaultPaths();
  const phase0DbPath = options.phase0DbPath ?? paths.phase0DbPath;
  const phase1DbPath = options.phase1DbPath ?? paths.phase1DbPath;
  const gmgnDbPath = options.gmgnDbPath ?? paths.gmgnDbPath;
  const phase2DbPath = options.phase2DbPath ?? paths.phase2DbPath;
  const pidPath = options.pidPath ?? paths.pidPath;
  const config = options.config ?? (await loadTradeConfig(true));
  const now = options.now ?? (() => Date.now() / 1000);
  const onStatus = options.onStatus ?? ((line) => process.stderr.write(`${line}\n`));
  const phase0Config = resolveRobinhoodChainConfig(config);
  const phase1Config = resolveRobinhoodPhase1Config(config);
  const phase2Config = resolveRobinhoodPhase2Config(config);
  if (!phase0Config.enabled || !phase1Config.enabled || !phase2Config.enabled) {
    throw new Error("Robinhood shadow daemon requires Phase 0, Phase 1, and Phase 2 to be enabled");
  }
  const intervalSeconds = Math.min(
    boundedInterval(options.intervalSeconds),
    phase0Config.collectSeconds,
    phase1Config.discoverySeconds,
    phase1Config.xEnabled ? phase1Config.xCollectSeconds : Number.POSITIVE_INFINITY,
    phase2Config.collectSeconds,
  );

  await mkdir(dirname(pidPath), { recursive: true });
  let lock: PidLockHandle | null = null;
  lock = await acquireDaemonPidLock(pidPath);
  let stopping = false;
  let wake: (() => void) | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  const phase1XCollector =
    options.collectors?.phase1X ??
    ((input: { config: TradeConfig; dbPath: string }) =>
      collectRobinhoodPhase1Accounts({ config: input.config, dbPath: input.dbPath }));
  const xRunner = createRobinhoodShadowXRunner(async () => {
    try {
      const result = await phase1XCollector({ config, dbPath: phase1DbPath });
      onStatus(
        `[robinhood-shadow] phase1-x ${result.status} accounts=${result.accountsChecked} posts=${result.postsObserved} health=${JSON.stringify(result.health)}`,
      );
    } catch (error) {
      onStatus(`[robinhood-shadow] phase1-x failed: ${boundedError(error)}`);
    }
  });
  const controller = new AbortController();
  const signal = controller.signal;
  const stop = () => {
    stopping = true;
    controller.abort();
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (options.signal?.aborted) stop();
  else options.signal?.addEventListener("abort", stop, { once: true });

  try {
    onStatus(`[robinhood-shadow] started interval=${intervalSeconds}s pidLock=${pidPath}`);
    const schedule: RobinhoodShadowScheduleState = {
      lastPhase0: Number.NEGATIVE_INFINITY,
      lastPhase1: Number.NEGATIVE_INFINITY,
      lastPhase1X: Number.NEGATIVE_INFINITY,
      lastPhase2: Number.NEGATIVE_INFINITY,
    };
    let phase0FirstAttempt = true;
    let phase1FirstAttempt = true;
    do {
      const startedAt = now();
      const stages = dueRobinhoodShadowStages(startedAt, schedule, {
        phase0: phase0Config.collectSeconds,
        phase1: phase1Config.discoverySeconds,
        phase2: phase2Config.collectSeconds,
      });
      const xDue =
        phase1Config.xEnabled && dueRobinhoodShadowX(startedAt, schedule.lastPhase1X, phase1Config.xCollectSeconds);
      if (stages.phase0 || stages.phase1 || stages.phase2) {
        const rebasePermissions = {
          phase0: stages.phase0 && phase0FirstAttempt,
          phase1: stages.phase1 && phase1FirstAttempt,
        };
        if (stages.phase0) schedule.lastPhase0 = startedAt;
        if (stages.phase1) schedule.lastPhase1 = startedAt;
        if (stages.phase2) schedule.lastPhase2 = startedAt;
        const result = await runRobinhoodShadowCycle({
          config,
          phase0DbPath,
          phase1DbPath,
          gmgnDbPath,
          phase2DbPath,
          onStatus,
          collectors: options.collectors,
          stages,
          rebasePermissions,
          signal,
          wait: options.wait,
        });
        if (result.phase0.status !== "skipped") phase0FirstAttempt = false;
        if (result.phase1.status !== "skipped") phase1FirstAttempt = false;
      }
      if (!stopping && !signal.aborted && xDue && xRunner.start()) schedule.lastPhase1X = startedAt;
      if (options.runOnce || stopping) break;
      const delayMs = Math.max(0, Math.round((startedAt + intervalSeconds - now()) * 1000));
      if (delayMs === 0) continue;
      await new Promise<void>((resolve) => {
        if (stopping) {
          resolve();
          return;
        }
        wake = resolve;
        wakeTimer = setTimeout(() => {
          wakeTimer = null;
          wake = null;
          resolve();
        }, delayMs);
      });
    } while (!stopping);
    await xRunner.drain();
    onStatus("[robinhood-shadow] stopped");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    options.signal?.removeEventListener("abort", stop);
    await lock.release();
    lock = null;
  }
}
