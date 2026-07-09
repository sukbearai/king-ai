import { cronMatches } from "../cron.js";
import { dotGet, enabledAlertRules, loadTradeConfig } from "./config.js";
import { resolveBriefingPushTg, runMorningBrief } from "./morning-brief.js";
import { runUnifiedRuleScheduler } from "./rule-scheduler.js";
import { getScratchpad } from "./scratchpad.js";
import { runProcessWatchdog } from "./process-watchdog.js";
import { runTwitterCollector } from "./twitter-collector.js";

export interface TradeDaemonOptions {
  pushTg?: boolean;
  dryRun?: boolean;
}

interface ScheduledTick {
  key: string;
  lastMinuteKey: string;
  cron: string;
  run: () => Promise<void>;
}

function minuteKey(date = new Date()): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

export async function runTradeDaemon(options: TradeDaemonOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const pushTg = resolveBriefingPushTg(config, options);
  const enabled = new Set(enabledAlertRules(config));
  const pad = getScratchpad();
  const onStatus = (line: string) => process.stderr.write(`${line}\n`);

  const ruleSchedulerLoop = runUnifiedRuleScheduler({
    pushTg,
    dryRun: options.dryRun,
    onStatus,
  });

  const briefHour = Number(dotGet(config, "briefing.schedule_hour", 5)) || 5;
  const briefCron = `0 ${briefHour} * * *`;

  const scheduled: ScheduledTick[] = [
    {
      key: "morning_brief",
      lastMinuteKey: "",
      cron: briefCron,
      run: async () => {
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
    const mk = minuteKey(now);
    for (const job of scheduled) {
      if (cronMatches(job.cron, now) && job.lastMinuteKey !== mk) {
        job.lastMinuteKey = mk;
        try {
          await job.run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[scheduler] ${job.key} failed: ${msg}\n`);
        }
      }
    }

    const ts = Date.now() / 1000;
    if (ts - lastRegime >= 4 * 3600) {
      lastRegime = ts;
      const regime = await pad.autoDetectRegime();
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

  process.stderr.write(`trade daemon started — rules=[${[...enabled].join(",")}] pushTg=${!!pushTg}\n`);

  await ruleSchedulerLoop;
}
