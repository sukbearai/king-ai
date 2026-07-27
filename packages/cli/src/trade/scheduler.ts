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

export interface TradeDaemonOptions {
  pushTg?: boolean;
  dryRun?: boolean;
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
  const releaseLock = async () => {
    await pidLock.release();
  };
  process.once("exit", () => {
    void releaseLock();
  });
  process.once("SIGINT", () => {
    void releaseLock().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void releaseLock().finally(() => process.exit(143));
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
  let lastWatchdog = 0;
  const twitterCollectorInterval = Number(dotGet(config, "data_sources.twitter.collect_seconds", 7200)) || 7200;
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
