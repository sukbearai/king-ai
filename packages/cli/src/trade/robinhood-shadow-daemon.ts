import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRADE_STATE_DIR } from "../paths.js";
import { loadTradeConfig, type TradeConfig } from "./config.js";
import { acquireDaemonPidLock, type PidLockHandle } from "./pid-lock.js";
import {
  collectRobinhoodChain,
  resolveRobinhoodChainConfig,
  type RobinhoodCollectionResult,
} from "./robinhood-chain.js";
import {
  collectRobinhoodPhase1,
  resolveRobinhoodPhase1Config,
  type RobinhoodPhase1Result,
} from "./robinhood-chain-phase1.js";
import {
  collectRobinhoodPhase2,
  resolveRobinhoodPhase2Config,
  type RobinhoodPhase2Result,
} from "./robinhood-chain-phase2.js";

export interface RobinhoodShadowCycleResult {
  phase0: { status: "ok" | "failed" | "skipped"; result?: RobinhoodCollectionResult; error?: string };
  phase1: { status: "ok" | "failed" | "skipped"; result?: RobinhoodPhase1Result; error?: string };
  phase2: { status: "ok" | "failed" | "skipped"; result?: RobinhoodPhase2Result; error?: string };
}

export interface RobinhoodShadowScheduleState {
  lastPhase0: number;
  lastPhase1: number;
  lastPhase2: number;
}

export interface RobinhoodShadowDaemonOptions {
  config?: TradeConfig;
  intervalSeconds?: number;
  runOnce?: boolean;
  phase0DbPath?: string;
  phase1DbPath?: string;
  phase2DbPath?: string;
  pidPath?: string;
  now?: () => number;
  onStatus?: (line: string) => void;
  collectors?: {
    phase0?: (options: { config: TradeConfig; dbPath: string }) => Promise<RobinhoodCollectionResult>;
    phase1?: (options: { config: TradeConfig; dbPath: string }) => Promise<RobinhoodPhase1Result>;
    phase2?: (options: {
      config: TradeConfig;
      phase1DbPath: string;
      phase2DbPath: string;
    }) => Promise<RobinhoodPhase2Result>;
  };
}

const DEFAULT_INTERVAL_SECONDS = 30;

function boundedInterval(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(86400, Math.max(30, Math.trunc(value!)));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function defaultPaths() {
  return {
    phase0DbPath: join(TRADE_STATE_DIR, "robinhood_chain.sqlite"),
    phase1DbPath: join(TRADE_STATE_DIR, "robinhood_chain_phase1.sqlite"),
    phase2DbPath: join(TRADE_STATE_DIR, "robinhood_chain_phase2.sqlite"),
    pidPath: join(TRADE_STATE_DIR, "robinhood-shadow.pid"),
  };
}

export async function runRobinhoodShadowCycle(
  options: Required<Pick<RobinhoodShadowDaemonOptions, "config" | "phase0DbPath" | "phase1DbPath" | "phase2DbPath">> &
    Pick<RobinhoodShadowDaemonOptions, "onStatus" | "collectors"> & {
      stages?: { phase0: boolean; phase1: boolean; phase2: boolean };
    },
): Promise<RobinhoodShadowCycleResult> {
  const onStatus = options.onStatus ?? (() => undefined);
  const stages = options.stages ?? { phase0: true, phase1: true, phase2: true };
  const phase0Collector =
    options.collectors?.phase0 ?? ((input) => collectRobinhoodChain({ config: input.config, dbPath: input.dbPath }));
  const phase1Collector =
    options.collectors?.phase1 ?? ((input) => collectRobinhoodPhase1({ config: input.config, dbPath: input.dbPath }));
  const phase2Collector =
    options.collectors?.phase2 ??
    ((input) =>
      collectRobinhoodPhase2({
        config: input.config,
        phase1DbPath: input.phase1DbPath,
        phase2DbPath: input.phase2DbPath,
      }));

  const result: RobinhoodShadowCycleResult = {
    phase0: { status: "skipped" },
    phase1: { status: "skipped" },
    phase2: { status: "skipped" },
  };

  if (stages.phase0) {
    try {
      result.phase0 = {
        status: "ok",
        result: await phase0Collector({ config: options.config, dbPath: options.phase0DbPath }),
      };
      onStatus(`[robinhood-shadow] phase0 ${result.phase0.result?.status ?? "ok"}`);
    } catch (error) {
      result.phase0 = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] phase0 failed: ${result.phase0.error}`);
    }
  }

  if (stages.phase1) {
    try {
      result.phase1 = {
        status: "ok",
        result: await phase1Collector({ config: options.config, dbPath: options.phase1DbPath }),
      };
      onStatus(`[robinhood-shadow] phase1 ${result.phase1.result?.status ?? "ok"}`);
    } catch (error) {
      result.phase1 = { status: "failed", error: boundedError(error) };
      onStatus(`[robinhood-shadow] phase1 failed: ${result.phase1.error}`);
    }
  }

  if (stages.phase2) {
    try {
      result.phase2 = {
        status: "ok",
        result: await phase2Collector({
          config: options.config,
          phase1DbPath: options.phase1DbPath,
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

export async function runRobinhoodShadowDaemon(options: RobinhoodShadowDaemonOptions = {}): Promise<void> {
  const paths = defaultPaths();
  const phase0DbPath = options.phase0DbPath ?? paths.phase0DbPath;
  const phase1DbPath = options.phase1DbPath ?? paths.phase1DbPath;
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
    phase2Config.collectSeconds,
  );

  await mkdir(dirname(pidPath), { recursive: true });
  let lock: PidLockHandle | null = null;
  lock = await acquireDaemonPidLock(pidPath);
  let stopping = false;
  let wake: (() => void) | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  const stop = () => {
    stopping = true;
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    onStatus(`[robinhood-shadow] started interval=${intervalSeconds}s pidLock=${pidPath}`);
    const schedule: RobinhoodShadowScheduleState = {
      lastPhase0: Number.NEGATIVE_INFINITY,
      lastPhase1: Number.NEGATIVE_INFINITY,
      lastPhase2: Number.NEGATIVE_INFINITY,
    };
    do {
      const startedAt = now();
      const stages = dueRobinhoodShadowStages(startedAt, schedule, {
        phase0: phase0Config.collectSeconds,
        phase1: phase1Config.discoverySeconds,
        phase2: phase2Config.collectSeconds,
      });
      if (stages.phase0 || stages.phase1 || stages.phase2) {
        if (stages.phase0) schedule.lastPhase0 = startedAt;
        if (stages.phase1) schedule.lastPhase1 = startedAt;
        if (stages.phase2) schedule.lastPhase2 = startedAt;
        await runRobinhoodShadowCycle({
          config,
          phase0DbPath,
          phase1DbPath,
          phase2DbPath,
          onStatus,
          collectors: options.collectors,
          stages,
        });
      }
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
    onStatus("[robinhood-shadow] stopped");
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await lock.release();
    lock = null;
  }
}
