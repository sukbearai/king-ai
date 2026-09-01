import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TRADE_STATE_DIR } from "../paths.js";
import {
  dotGet,
  enabledAlertRules,
  loadTradeConfig,
  TradeConfigError,
  validateTradeConfigShape,
  type TradeConfig,
} from "./config.js";
import { resolveBriefingPushTg, runMorningBrief } from "./morning-brief.js";
import { acquireDaemonPidLock } from "./pid-lock.js";
import { runUnifiedRuleScheduler } from "./rule-scheduler.js";
import { getTradeStore } from "./store.js";
import { runProcessWatchdog } from "./process-watchdog.js";
import { runTwitterCollector } from "./twitter-collector.js";
import { collectRobinhoodChain, resolveRobinhoodChainConfig } from "./robinhood-chain.js";
import {
  collectRobinhoodPhase1,
  collectRobinhoodPhase1Accounts,
  resolveRobinhoodPhase1Config,
} from "./robinhood-chain-phase1.js";
import { collectRobinhoodGmgn, type RobinhoodGmgnResult } from "./robinhood-chain-gmgn.js";
import { collectRobinhoodPhase2, resolveRobinhoodPhase2Config } from "./robinhood-chain-phase2.js";

export interface TradeDaemonOptions {
  pushTg?: boolean;
  dryRun?: boolean;
}

export type RobinhoodChainCollector = typeof collectRobinhoodChain;

export async function runRobinhoodChainCollectorJob(
  config: TradeConfig,
  collector: RobinhoodChainCollector = collectRobinhoodChain,
  onStatus: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  allowRealtimeRebase = true,
): Promise<void> {
  try {
    const result = await collector({ config, allowRealtimeRebase });
    onStatus(
      `[robinhood-chain] ${result.status} latest=${result.latestBlock ?? "-"} target=${result.targetBlock ?? "-"} realtime=${result.realtimePersistedBlock ?? result.persistedBlock ?? "-"} backfill=${result.backfillPersistedBlock ?? "-"}/${result.backfillTargetBlock ?? "-"} historyComplete=${result.historyComplete ?? "-"} fetched=${result.fetchedBlocks ?? 0}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onStatus(`[robinhood-chain] failed: ${msg.slice(0, 500)}`);
  }
}

export type RobinhoodPhase1Collector = typeof collectRobinhoodPhase1;

export async function runRobinhoodPhase1CollectorJob(
  config: TradeConfig,
  collector: RobinhoodPhase1Collector = collectRobinhoodPhase1,
  onStatus: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  allowRealtimeRebase = true,
): Promise<void> {
  try {
    const result = await collector({ config, allowRealtimeRebase });
    onStatus(
      `[robinhood-phase1] ${result.status} delivery=${result.delivery} latest=${result.latestBlock ?? "-"} target=${result.targetBlock ?? "-"} realtime=${result.realtimePersistedBlock ?? result.persistedBlock ?? "-"} backfill=${result.backfillPersistedBlock ?? "-"}/${result.backfillTargetBlock ?? "-"} historyComplete=${result.historyComplete ?? "-"} pools=${result.poolsDiscovered ?? 0} swaps=${result.swapsObserved ?? 0} qualified=${result.candidatesQualified ?? 0}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onStatus(`[robinhood-phase1] failed: ${msg.slice(0, 500)}`);
  }
}

export async function runRobinhoodPhase1XCollectorJob(
  config: TradeConfig,
  collector: typeof collectRobinhoodPhase1Accounts = collectRobinhoodPhase1Accounts,
  onStatus: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  try {
    const result = await collector({ config });
    onStatus(
      `[robinhood-x] ${result.status} accounts=${result.accountsChecked} posts=${result.postsObserved} health=${JSON.stringify(result.health)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onStatus(`[robinhood-x] failed: ${msg.slice(0, 500)}`);
  }
}

export async function runRobinhoodGmgnCollectorJob(
  config: TradeConfig,
  collector: typeof collectRobinhoodGmgn = collectRobinhoodGmgn,
  onStatus: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  signal?: AbortSignal,
): Promise<RobinhoodGmgnResult | null> {
  try {
    const result = await collector({ config, signal });
    onStatus(
      `[robinhood-gmgn] ${result.status} observations=${result.observationsPersisted} qualified=${result.candidatesQualified} verified=${result.candidatesVerified} error=${result.errorCategory ?? "-"}`,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCategory = message.match(/gmgn_[a-z0-9_]+/i)?.[0]?.toLowerCase() ?? "gmgn_collector_error";
    onStatus(`[robinhood-gmgn] failed: ${errorCategory}`);
    return null;
  }
}

export async function runRobinhoodPhase2CollectorJob(
  config: TradeConfig,
  collector: typeof collectRobinhoodPhase2 = collectRobinhoodPhase2,
  onStatus: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<void> {
  try {
    const result = await collector({ config });
    onStatus(
      `[robinhood-phase2] ${result.status} delivery=${result.delivery} drafts=${result.draftsMaterialized} stale=${result.draftsStaled} readiness=${result.readiness?.state ?? "-"}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onStatus(`[robinhood-phase2] failed: ${msg.slice(0, 500)}`);
  }
}

interface SchedulerStateFile {
  morning_brief_last_run?: string;
}

const SCHEDULER_STATE_PATH = join(TRADE_STATE_DIR, "scheduler_state.json");

/** Local calendar date YYYY-MM-DD (machine local timezone). */
export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Catch-up semantics for morning brief: fire once the local clock is at/after
 * briefHour:00 and today's date has not yet been claimed.
 */
export function shouldRunMorningBrief(now: Date, lastRunDate: string | null, briefHour: number): boolean {
  const hour = Number.isFinite(briefHour) ? briefHour : 5;
  if (now.getHours() < hour) return false;
  const today = localDateString(now);
  if (lastRunDate === today) return false;
  return true;
}

export async function readMorningBriefLastRun(path = SCHEDULER_STATE_PATH): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as SchedulerStateFile;
    const value = raw?.morning_brief_last_run;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function claimMorningBriefRun(date: string, path = SCHEDULER_STATE_PATH): Promise<void> {
  let existing: SchedulerStateFile = {};
  try {
    existing = JSON.parse(await readFile(path, "utf8")) as SchedulerStateFile;
    if (!existing || typeof existing !== "object") existing = {};
  } catch {
    existing = {};
  }
  existing.morning_brief_last_run = date;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(existing)}\n`, "utf8");
}

interface ScheduledTick {
  key: string;
  run: (now: Date) => Promise<void>;
}

export async function runTradeDaemon(options: TradeDaemonOptions = {}): Promise<void> {
  let config: TradeConfig;
  try {
    config = await loadTradeConfig(true);
  } catch (err) {
    if (err instanceof TradeConfigError) {
      process.stderr.write(`[trade] config error: ${err.message}\n`);
      process.exitCode = 1;
      throw err;
    }
    throw err;
  }

  for (const warning of validateTradeConfigShape(config)) {
    process.stderr.write(`[trade] config warning: ${warning}\n`);
  }

  const pidLock = await acquireDaemonPidLock();
  const daemonController = new AbortController();
  let drainCollectors = async (): Promise<void> => undefined;
  const releaseLock = async () => {
    await pidLock.release();
  };
  process.once("exit", () => {
    void releaseLock();
  });
  process.once("SIGINT", () => {
    daemonController.abort();
    void drainCollectors()
      .finally(releaseLock)
      .finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    daemonController.abort();
    void drainCollectors()
      .finally(releaseLock)
      .finally(() => process.exit(143));
  });

  const pushTg = resolveBriefingPushTg(config, options);
  const enabled = new Set(
    enabledAlertRules(config, {
      onUnknown: (id) => process.stderr.write(`[trade] skipping unknown rule id: ${id}\n`),
    }),
  );
  const store = getTradeStore();
  const onStatus = (line: string) => process.stderr.write(`${line}\n`);

  const ruleSchedulerLoop = runUnifiedRuleScheduler({
    pushTg,
    dryRun: options.dryRun,
    onStatus,
  });

  const briefHour = Number(dotGet(config, "briefing.schedule_hour", 5)) || 5;

  const scheduled: ScheduledTick[] = [
    {
      key: "morning_brief",
      run: async (now) => {
        const lastRun = await readMorningBriefLastRun();
        if (!shouldRunMorningBrief(now, lastRun, briefHour)) return;
        const today = localDateString(now);
        // Claim-first: persist today's date before executing so failures still
        // count as "attempted once today" (same as old once-per-day cron).
        await claimMorningBriefRun(today);
        process.stderr.write("[scheduler] morning_brief\n");
        await runMorningBrief({ pushTg, dryRun: options.dryRun });
      },
    },
  ];

  let lastRegime = 0;
  let lastTwitterCollector = 0;
  let lastRobinhoodChainCollector = 0;
  let robinhoodChainInFlight: Promise<void> | null = null;
  let robinhoodChainFirstAttempt = true;
  let lastRobinhoodPhase1Collector = 0;
  let robinhoodPhase1InFlight: Promise<void> | null = null;
  let robinhoodPhase1FirstAttempt = true;
  let lastRobinhoodPhase1XCollector = 0;
  let robinhoodPhase1XInFlight: Promise<void> | null = null;
  let lastRobinhoodPhase2Collector = 0;
  let robinhoodPhase2InFlight: Promise<void> | null = null;
  drainCollectors = async () => {
    await Promise.allSettled(
      [robinhoodChainInFlight, robinhoodPhase1InFlight, robinhoodPhase1XInFlight, robinhoodPhase2InFlight].filter(
        (task): task is Promise<void> => task != null,
      ),
    );
  };
  let lastWatchdog = 0;
  const twitterCollectorInterval = Number(dotGet(config, "data_sources.twitter.collect_seconds", 7200)) || 7200;
  const robinhoodChainConfig = resolveRobinhoodChainConfig(config);
  const robinhoodPhase1Config = resolveRobinhoodPhase1Config(config);
  const robinhoodPhase2Config = resolveRobinhoodPhase2Config(config);
  const watchdogInterval = Number(dotGet(config, "watchdog.interval_seconds", 300)) || 300;

  const tick = async () => {
    const now = new Date();
    for (const job of scheduled) {
      try {
        await job.run(now);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[scheduler] ${job.key} failed: ${msg}\n`);
      }
    }

    const ts = Date.now() / 1000;
    if (ts - lastRegime >= 4 * 3600) {
      lastRegime = ts;
      const regime = await store.scratchpad.autoDetectRegime();
      if (regime) process.stderr.write(`[regime] ${regime}\n`);
    }

    if (ts - lastTwitterCollector >= twitterCollectorInterval) {
      lastTwitterCollector = ts;
      try {
        await runTwitterCollector();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[twitter-collector] failed: ${msg}\n`);
      }
    }

    if (
      robinhoodChainConfig.enabled &&
      robinhoodPhase1Config.discoverySource === "rpc" &&
      ts - lastRobinhoodChainCollector >= robinhoodChainConfig.collectSeconds &&
      !robinhoodChainInFlight
    ) {
      const allowRealtimeRebase = robinhoodChainFirstAttempt;
      robinhoodChainFirstAttempt = false;
      lastRobinhoodChainCollector = ts;
      robinhoodChainInFlight = runRobinhoodChainCollectorJob(
        config,
        collectRobinhoodChain,
        onStatus,
        allowRealtimeRebase,
      ).finally(() => {
        robinhoodChainInFlight = null;
      });
    }

    if (
      robinhoodChainConfig.enabled &&
      robinhoodPhase1Config.enabled &&
      robinhoodPhase1Config.xEnabled &&
      ts - lastRobinhoodPhase1XCollector >= robinhoodPhase1Config.xCollectSeconds &&
      !robinhoodPhase1XInFlight
    ) {
      lastRobinhoodPhase1XCollector = ts;
      robinhoodPhase1XInFlight = runRobinhoodPhase1XCollectorJob(config).finally(() => {
        robinhoodPhase1XInFlight = null;
      });
    }

    if (
      robinhoodChainConfig.enabled &&
      robinhoodPhase1Config.enabled &&
      ts - lastRobinhoodPhase1Collector >= robinhoodPhase1Config.discoverySeconds &&
      !robinhoodPhase1InFlight
    ) {
      lastRobinhoodPhase1Collector = ts;
      if (robinhoodPhase1Config.discoverySource === "gmgn") {
        robinhoodPhase1InFlight = runRobinhoodGmgnCollectorJob(
          config,
          collectRobinhoodGmgn,
          onStatus,
          daemonController.signal,
        )
          .then(() => undefined)
          .finally(() => {
            robinhoodPhase1InFlight = null;
          });
      } else {
        const allowRealtimeRebase = robinhoodPhase1FirstAttempt;
        robinhoodPhase1FirstAttempt = false;
        robinhoodPhase1InFlight = runRobinhoodPhase1CollectorJob(
          config,
          collectRobinhoodPhase1,
          onStatus,
          allowRealtimeRebase,
        ).finally(() => {
          robinhoodPhase1InFlight = null;
        });
      }
    }

    if (
      robinhoodChainConfig.enabled &&
      robinhoodPhase1Config.enabled &&
      robinhoodPhase2Config.enabled &&
      ts - lastRobinhoodPhase2Collector >= robinhoodPhase2Config.collectSeconds &&
      !robinhoodPhase1InFlight &&
      !robinhoodPhase2InFlight
    ) {
      lastRobinhoodPhase2Collector = ts;
      robinhoodPhase2InFlight = runRobinhoodPhase2CollectorJob(config).finally(() => {
        robinhoodPhase2InFlight = null;
      });
    }

    if (ts - lastWatchdog >= watchdogInterval) {
      lastWatchdog = ts;
      try {
        await runProcessWatchdog({ kill: true, pushTg, log: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[watchdog] failed: ${msg}\n`);
      }
    }
  };

  setInterval(() => void tick(), 30_000);
  await tick();

  process.stderr.write(
    `trade daemon started — rules=[${[...enabled].join(",")}] pushTg=${!!pushTg} pidLock=${pidLock.path}\n`,
  );

  await ruleSchedulerLoop;
}
