import { cronMatches } from "../cron.js";
import { runAlertAggregator } from "./alert-aggregator.js";
import { dotGet, enabledAlertRules, loadTradeConfig, defaultPollSeconds } from "./config.js";
import { runRuleLoop } from "./alert-rule.js";
import { runMorningBrief } from "./morning-brief.js";
import { createRule, listRuleIds } from "./rules/registry.js";
import { getScratchpad } from "./scratchpad.js";
import { runSignalScan } from "../signal-scan.js";
import { runAccuracyCycle } from "./alert-accuracy.js";
import { runProcessWatchdog } from "./process-watchdog.js";
import { runTwitterCollector } from "./twitter-collector.js";
import { runWeeklyReview } from "./weekly-review.js";

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
  const pollSeconds = defaultPollSeconds(config);
  const enabled = new Set(enabledAlertRules(config));
  const pad = getScratchpad();

  const ruleLoops: Array<Promise<void>> = [];
  for (const id of listRuleIds()) {
    if (!enabled.has(id)) continue;
    const rule = createRule(id);
    if (!rule) continue;
    ruleLoops.push(
      runRuleLoop(rule, {
        pollSeconds,
        pushTg: options.pushTg,
        dryRun: options.dryRun,
        onStatus: (line) => process.stderr.write(`${line}\n`)
      })
    );
  }

  const briefHour = Number(dotGet(config, "briefing.schedule_hour", 5)) || 5;
  const briefCron = `0 ${briefHour} * * *`;
  const ruleUCron = "0 22 * * *";
  const weeklyReviewCron = "0 6 * * *";

  const scheduled: ScheduledTick[] = [
    {
      key: "morning_brief",
      lastMinuteKey: "",
      cron: briefCron,
      run: async () => {
        process.stderr.write("[scheduler] morning_brief\n");
        await runMorningBrief({ pushTg: options.pushTg, dryRun: options.dryRun });
      }
    },
    {
      key: "rule_u",
      lastMinuteKey: "",
      cron: ruleUCron,
      run: async () => {
        if (!enabled.has("u")) return;
        const rule = createRule("u");
        if (!rule) return;
        process.stderr.write("[scheduler] rule_u once\n");
        await runRuleLoop(rule, { runOnce: true, pushTg: options.pushTg, dryRun: options.dryRun });
      }
    },
    {
      key: "weekly_review",
      lastMinuteKey: "",
      cron: weeklyReviewCron,
      run: async () => {
        process.stderr.write("[scheduler] weekly_review\n");
        await runWeeklyReview({ pushTg: options.pushTg, dryRun: options.dryRun });
      }
    }
  ];

  let lastAggregator = 0;
  let lastSignalScan = 0;
  let lastRegime = 0;
  let lastTwitterCollector = 0;
  let lastAccuracy = 0;
  let lastWatchdog = 0;
  const twitterCollectorInterval = Number(dotGet(config, "data_sources.twitter.collect_seconds", 7200)) || 7200;
  const accuracyInterval = Number(dotGet(config, "accuracy.poll_seconds", 1800)) || 1800;
  const watchdogInterval = Number(dotGet(config, "watchdog.interval_seconds", 300)) || 300;
  const aggregatorInterval = Number(dotGet(config, "alerts.aggregator_seconds", 300)) || 300;
  const signalScanInterval = Number(dotGet(config, "signals.scan_seconds", 0)) || 0;

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
    if (ts - lastAggregator >= aggregatorInterval) {
      lastAggregator = ts;
      try {
        const msgs = await runAlertAggregator({ pushTg: options.pushTg, dryRun: options.dryRun });
        if (msgs.length) process.stderr.write(`[aggregator] ${msgs.length} correlation(s)\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[aggregator] failed: ${msg}\n`);
      }
    }

    if (signalScanInterval > 0 && ts - lastSignalScan >= signalScanInterval) {
      lastSignalScan = ts;
      try {
        await runSignalScan({ pushTg: options.pushTg, dryRun: options.dryRun });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[signal-scan] failed: ${msg}\n`);
      }
    }

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

    if (ts - lastAccuracy >= accuracyInterval) {
      lastAccuracy = ts;
      try {
        const stats = await runAccuracyCycle({ showStats: false });
        if (stats) process.stderr.write(`[alert-accuracy]\n${stats}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[alert-accuracy] failed: ${msg}\n`);
      }
    }

    if (ts - lastWatchdog >= watchdogInterval) {
      lastWatchdog = ts;
      try {
        await runProcessWatchdog({ kill: true, pushTg: options.pushTg, log: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[watchdog] failed: ${msg}\n`);
      }
    }
  };

  setInterval(() => void tick(), 30_000);
  await tick();

  process.stderr.write(
    `trade daemon started — rules=[${[...enabled].join(",")}] poll=${pollSeconds}s pushTg=${!!options.pushTg}\n`
  );

  await Promise.all(ruleLoops);
}