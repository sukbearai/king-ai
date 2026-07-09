import { AlertState, formatAlert } from "./alert-rule.js";
import { cooldownDefaults, defaultTickTimeoutMsFor, getRuleMeta, normalizeRuleId } from "./domain.js";
import { dotGet, enabledAlertRules, loadTradeConfig, resolveCooldownConfig, type TradeConfig } from "./config.js";
import { createRuleAsync } from "./rules/registry.js";
import { isBriefSection, runMorningBrief, type BriefSection } from "./morning-brief.js";
import { sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";
import { withTimeout } from "./timeout.js";
import { runTwitterCollector } from "./twitter-collector.js";

const DEFAULT_VERIFY_BRIEF_SECTIONS: BriefSection[] = ["market", "stocks", "treasury", "telegram", "twitter"];
const DEFAULT_VERIFY_STEP_TIMEOUT_MS = 60_000;

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

export function verifyRuleTimeoutMs(config: TradeConfig, ruleId: string): number {
  const configured = Number(dotGet(config, "verify.step_timeout_ms", NaN));
  if (Number.isFinite(configured) && configured > 0) return configured;
  const canonical = normalizeRuleId(ruleId) ?? ruleId;
  return defaultTickTimeoutMsFor(canonical);
}

/** @deprecated Prefer withTimeout from ./timeout.js — kept for tests. */
export async function withVerifyTimeout<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<T> {
  return withTimeout(label, timeoutMs, task);
}

function ruleVerifyLabel(ruleId: string): string {
  const meta = getRuleMeta(ruleId);
  if (!meta) return ruleId;
  return `${meta.displayName}`;
}

export async function runVerifySignalsPush(options: VerifySignalsOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const hours = Number(dotGet(config, "briefing.hours_lookback", 24)) || 24;
  const stamp = formatDisplayTime(new Date(), "hm");
  const timeoutMs = verifyStepTimeoutMs(config);
  const verifyRules = enabledAlertRules(config, {
    onUnknown: (id) => process.stderr.write(`[verify-tg] skipping unknown rule id: ${id}\n`),
  });
  const verifyBriefSections = resolveVerifyBriefSections(config);

  if (options.collect !== false) {
    process.stderr.write("[verify-tg] running twitter-collector...\n");
    try {
      await withTimeout("twitter-collector", timeoutMs, () => runTwitterCollector());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[verify-tg] twitter-collector failed: ${msg}\n`);
    }
  }

  const state = new AlertState(resolveCooldownConfig(config));

  for (const ruleId of verifyRules) {
    const label = ruleVerifyLabel(ruleId);
    const header = `🧪 信号验证 [${ruleId}] ${label} — ${stamp}`;
    const ruleTimeoutMs = verifyRuleTimeoutMs(config, ruleId);
    let body: string;
    try {
      body = await withTimeout(`rule:${ruleId}`, ruleTimeoutMs, async () => {
        const rule = await createRuleAsync(ruleId);
        if (!rule) {
          return `${header}\n\n❌ 规则未注册`;
        }
        const alerts = await rule.check(state);
        if (!alerts.length) {
          return `${header}\n\n✅ 采集完成，当前无 warning/critical 级告警`;
        }
        return [header, "", ...alerts.map((a) => formatAlert(a))].join("\n");
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
      const content = await withTimeout(`brief:${section}`, timeoutMs, () =>
        runMorningBrief({ sections: [section], hours, dryRun: true }),
      );
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
  process.stderr.write(
    `[verify-tg] done — ${totalMessages} messages (${verifyRules.length} rules + ${verifyBriefSections.length} brief sections)\n`,
  );
}

// re-export for tests that may import cooldownDefaults via verify
export { cooldownDefaults };
