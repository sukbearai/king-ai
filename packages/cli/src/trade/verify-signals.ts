import { AlertState, COOLDOWN_DEFAULTS, formatAlert } from "./alert-rule.js";
import { dotGet, loadTradeConfig } from "./config.js";
import { createRuleAsync } from "./rules/registry.js";
import { runMorningBrief, type BriefSection } from "./morning-brief.js";
import { sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { runTwitterCollector } from "./twitter-collector.js";

const VERIFY_RULES = ["e", "f", "t", "tm", "discord_wba", "q"] as const;
const VERIFY_BRIEF_SECTIONS: BriefSection[] = ["stocks", "telegram", "twitter"];

const RULE_LABELS: Record<string, string> = {
  e: "Meme 监控 (tg)",
  f: "自选股 (OpenCLI/Yahoo)",
  t: "名人推文 (OpenCLI+agent)",
  tm: "Ticker 提及加速",
  discord_wba: "Discord WBA (OpenCLI)",
  q: "PANews (agent)"
};

export interface VerifySignalsOptions {
  collect?: boolean;
  dryRun?: boolean;
}

export async function runVerifySignalsPush(options: VerifySignalsOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const hours = Number(dotGet(config, "briefing.hours_lookback", 24)) || 24;
  const stamp = formatDisplayTime(new Date(), "hm");

  if (options.collect !== false) {
    process.stderr.write("[verify-tg] running twitter-collector...\n");
    try {
      await runTwitterCollector();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[verify-tg] twitter-collector failed: ${msg}\n`);
    }
  }

  const state = new AlertState({ ...COOLDOWN_DEFAULTS });

  for (const ruleId of VERIFY_RULES) {
    const label = RULE_LABELS[ruleId] ?? ruleId;
    const header = `🧪 信号验证 [${ruleId}] ${label} — ${stamp}`;
    let body: string;
    try {
      const rule = await createRuleAsync(ruleId);
      if (!rule) {
        body = `${header}\n\n❌ 规则未注册`;
      } else {
        const alerts = await rule.check(state);
        if (!alerts.length) {
          body = `${header}\n\n✅ 采集完成，当前无 warning/critical 级告警`;
        } else {
          body = [header, "", ...alerts.map((a) => formatAlert(a))].join("\n");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      body = `${header}\n\n❌ 异常: ${msg}`;
    }

    process.stdout.write(`${body}\n\n---\n\n`);
    if (!options.dryRun) {
      const ok = await sendTelegram(body, config);
      process.stderr.write(`[verify-tg] ${ruleId} → telegram ${ok ? "ok" : "failed"}\n`);
    }
  }

  for (const section of VERIFY_BRIEF_SECTIONS) {
    const header = `🧪 晨报验证 [${section}] — ${stamp}`;
    let body: string;
    try {
      const content = await runMorningBrief({ sections: [section], hours, dryRun: true });
      body = `${header}\n\n${content.trim()}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      body = `${header}\n\n❌ 异常: ${msg}`;
    }

    process.stdout.write(`${body}\n\n---\n\n`);
    if (!options.dryRun) {
      const ok = await sendTelegram(body, config);
      process.stderr.write(`[verify-tg] brief:${section} → telegram ${ok ? "ok" : "failed"}\n`);
    }
  }

  process.stderr.write("[verify-tg] done — 9 messages (6 rules + 3 brief sections)\n");
}