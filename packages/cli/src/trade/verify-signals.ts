import { AlertState, COOLDOWN_DEFAULTS, formatAlert } from "./alert-rule.js";
import { dotGet, enabledAlertRules, loadTradeConfig, type TradeConfig } from "./config.js";
import { createRuleAsync } from "./rules/registry.js";
import { isBriefSection, runMorningBrief, type BriefSection } from "./morning-brief.js";
import { sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { runTwitterCollector } from "./twitter-collector.js";

const DEFAULT_VERIFY_BRIEF_SECTIONS: BriefSection[] = ["market", "stocks", "treasury", "telegram", "twitter"];
const DEFAULT_VERIFY_STEP_TIMEOUT_MS = 60_000;

const RULE_LABELS: Record<string, string> = {
  b: "美债抛售 / 收益率 (Yahoo)",
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

export function resolveVerifyBriefSections(config: TradeConfig): BriefSection[] {
  const enabled = dotGet(config, "briefing.enabled", DEFAULT_VERIFY_BRIEF_SECTIONS);
  const raw = Array.isArray(enabled) ? enabled.map(String) : DEFAULT_VERIFY_BRIEF_SECTIONS;
  const sections = raw.filter(isBriefSection);
  return sections.length ? sections : DEFAULT_VERIFY_BRIEF_SECTIONS;
}

export function verifyStepTimeoutMs(config: TradeConfig): number {
  const value = Number(dotGet(config, "verify.step_timeout_ms", DEFAULT_VERIFY_STEP_TIMEOUT_MS));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_VERIFY_STEP_TIMEOUT_MS;
}

export async function withVerifyTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runVerifySignalsPush(options: VerifySignalsOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const hours = Number(dotGet(config, "briefing.hours_lookback", 24)) || 24;
  const stamp = formatDisplayTime(new Date(), "hm");
  const timeoutMs = verifyStepTimeoutMs(config);
  const verifyRules = enabledAlertRules(config);
  const verifyBriefSections = resolveVerifyBriefSections(config);

  if (options.collect !== false) {
    process.stderr.write("[verify-tg] running twitter-collector...\n");
    try {
      await withVerifyTimeout("twitter-collector", timeoutMs, () => runTwitterCollector());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[verify-tg] twitter-collector failed: ${msg}\n`);
    }
  }

  const state = new AlertState({ ...COOLDOWN_DEFAULTS });

  for (const ruleId of verifyRules) {
    const label = RULE_LABELS[ruleId] ?? ruleId;
    const header = `🧪 信号验证 [${ruleId}] ${label} — ${stamp}`;
    let body: string;
    try {
      body = await withVerifyTimeout(`rule:${ruleId}`, timeoutMs, async () => {
        const rule = await createRuleAsync(ruleId);
        if (!rule) {
          return `${header}\n\n❌ 规则未注册`;
        }
        const alerts = await rule.check(state);
        if (!alerts.length) {
          return `${header}\n\n✅ 采集完成，当前无 warning/critical 级告警`;
        } else {
          return [header, "", ...alerts.map((a) => formatAlert(a))].join("\n");
        }
      });
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

  for (const section of verifyBriefSections) {
    const header = `🧪 晨报验证 [${section}] — ${stamp}`;
    let body: string;
    try {
      const content = await withVerifyTimeout(`brief:${section}`, timeoutMs, () => (
        runMorningBrief({ sections: [section], hours, dryRun: true })
      ));
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

  const totalMessages = verifyRules.length + verifyBriefSections.length;
  process.stderr.write(`[verify-tg] done — ${totalMessages} messages (${verifyRules.length} rules + ${verifyBriefSections.length} brief sections)\n`);
}
