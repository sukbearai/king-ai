import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appendJsonl } from "../jsonl.js";
import { SIGNAL_ALERT_LOG_PATH } from "../paths.js";
import { dotGet, loadTradeConfig, type TradeConfig } from "./config.js";
import { fetchMajorPrices, nowDisplay } from "./data-helpers.js";
import { getRuleStateStore } from "./rule-state.js";
import { getScratchpad } from "./scratchpad.js";
import { chunkAlertMessages, sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";

export type AlertSeverity = "info" | "warning" | "critical";

export interface Alert {
  rule: string;
  severity: AlertSeverity;
  title: string;
  detail: string;
  timestamp?: string;
  direction: number;
  strength: number;
  asset: string;
  tokenContract: string;
  tokenChain: string;
  tokenMcap: number;
  tags: string[];
}

export function createAlert(partial: Partial<Alert> & Pick<Alert, "rule" | "severity" | "title" | "detail">): Alert {
  return {
    timestamp: "",
    direction: 0,
    strength: 0,
    asset: "",
    tokenContract: "",
    tokenChain: "",
    tokenMcap: 0,
    tags: [],
    ...partial
  };
}

export function formatAlert(alert: Alert): string {
  const icons: Record<AlertSeverity, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };
  const icon = icons[alert.severity] ?? "📢";
  return `${icon} [${alert.rule}] ${alert.title}\n${alert.detail}`;
}

export const COOLDOWN_DEFAULTS: Record<string, number> = {
  a: 600, b: 3600, c: 1800, d: 7200, e: 600, f: 3600, g: 3600, h: 1800,
  i: 1800, j: 600, k: 86400, l: 3600, m: 3600, n: 600, o: 1800, p: 86400,
  q: 86400, r: 3600, s: 1800, t: 600, u: 21600, discord_wba: 1800
};

const TG_SEVERITY_ORDER: Record<AlertSeverity, number> = { info: 0, warning: 1, critical: 2 };
const MIN_TG_SEVERITY: AlertSeverity = "warning";
const DAILY_PUSH_CAP: Record<string, number> = {
  "PANews事件": 5, "Meme 新币": 8, "大户转账": 3, "聪明钱": 8,
  "股票异动": 3, "宏观经济": 3, Polymarket: 8, "提及加速": 5
};
const DEFAULT_DAILY_CAP = 10;

let priceCache: { ts: number; prices: Record<string, number> } | null = null;

async function cachedPrices(): Promise<Record<string, number>> {
  const now = Date.now() / 1000;
  if (priceCache && now - priceCache.ts < 30) return priceCache.prices;
  const prices = await fetchMajorPrices();
  priceCache = { ts: now, prices };
  return prices;
}

export class AlertState {
  cooldowns: Record<string, number> = {};
  cooldownConfig: Record<string, number>;

  constructor(cooldownConfig: Record<string, number>) {
    this.cooldownConfig = cooldownConfig;
  }

  canAlert(key: string, cooldown?: number): boolean {
    const rulePrefix = key.includes("_") ? key.split("_")[0]! : key;
    const cd = cooldown ?? this.cooldownConfig[rulePrefix] ?? 300;
    const now = Date.now() / 1000;
    const last = this.cooldowns[key] ?? 0;
    if (now - last < cd) return false;
    this.cooldowns[key] = now;
    return true;
  }
}

export interface AlertRule {
  readonly name: string;
  readonly ruleKey: string;
  readonly defaultCooldown: number;
  check(state: AlertState): Promise<Alert[]> | Alert[];
}

export interface RunRuleLoopOptions {
  pollSeconds?: number;
  pushTg?: boolean;
  dryRun?: boolean;
  runOnce?: boolean;
  onStatus?: (line: string) => void;
}

async function writeAlertsJsonl(alerts: Alert[]): Promise<void> {
  const prices = await cachedPrices();
  const regime = await getScratchpad().getRegime();
  for (const alert of alerts) {
    await appendJsonl(SIGNAL_ALERT_LOG_PATH, {
      rule: alert.rule,
      severity: alert.severity,
      title: alert.title,
      detail: alert.detail,
      timestamp: new Date().toISOString(),
      prices,
      direction: alert.direction,
      strength: alert.strength,
      asset: alert.asset,
      token_contract: alert.tokenContract,
      token_chain: alert.tokenChain,
      token_mcap: alert.tokenMcap,
      regime
    });
  }
}

async function filterTgWorthy(alerts: Alert[]): Promise<Alert[]> {
  const store = getRuleStateStore();
  const minLevel = TG_SEVERITY_ORDER[MIN_TG_SEVERITY];
  const result: Alert[] = [];
  for (const a of alerts) {
    if (TG_SEVERITY_ORDER[a.severity] < minLevel) continue;
    if (a.severity === "critical") {
      result.push(a);
      continue;
    }
    const cap = DAILY_PUSH_CAP[a.rule] ?? DEFAULT_DAILY_CAP;
    const count = await store.getDailyPushCount(a.rule);
    if (count >= cap) continue;
    await store.incrementDailyPushCount(a.rule);
    result.push(a);
  }
  return result;
}

async function applyRegimeCap(alerts: Alert[]): Promise<void> {
  const regime = await getScratchpad().getRegime();
  if (regime !== "risk_on") return;
  for (const alert of alerts) {
    if (alert.direction < 0 && (alert.severity === "warning" || alert.severity === "critical") && !alert.tags.includes("regime_gated")) {
      alert.severity = "info";
    }
  }
}

function directionLabel(alert: Alert): string {
  if (alert.direction < 0) return "跌破";
  if (alert.direction > 0) return "突破";
  if (alert.title.includes("跌") || alert.title.includes("超卖") || alert.title.includes("下轨")) return "跌破";
  return "突破";
}

export async function runRuleLoop(rule: AlertRule, options: RunRuleLoopOptions = {}): Promise<void> {
  const config = await loadTradeConfig();
  const cdOverrides = (dotGet(config, "alerts.cooldowns", {}) ?? {}) as Record<string, number>;
  const cooldownConfig = { ...COOLDOWN_DEFAULTS, ...cdOverrides };
  const state = new AlertState(cooldownConfig);
  const store = getRuleStateStore();
  const pollSeconds = options.pollSeconds ?? (Number(dotGet(config, "alerts.poll_seconds", 120)) || 120);
  const pad = getScratchpad();
  let lastRegimeCheck = 0;
  const REGIME_INTERVAL = 4 * 3600;

  const alertDir = dirname(SIGNAL_ALERT_LOG_PATH);
  await mkdir(alertDir, { recursive: true });

  const maybeUpdateRegime = async () => {
    const now = Date.now() / 1000;
    if (now - lastRegimeCheck < REGIME_INTERVAL) return;
    lastRegimeCheck = now;
    await pad.autoDetectRegime();
  };

  await maybeUpdateRegime();

  for (;;) {
    try {
      await maybeUpdateRegime();
      const t0 = Date.now();
      let alerts = await rule.check(state);
      const elapsedMs = Date.now() - t0;

      await store.update((s) => {
        s.heartbeats[rule.ruleKey] = {
          ruleName: rule.name,
          lastCheck: Date.now() / 1000,
          status: "ok",
          durationMs: elapsedMs
        };
      });

      if (alerts.length) {
        await applyRegimeCap(alerts);

        const message = [`🔔 交易告警 — ${nowDisplay()}\n`, ...alerts.flatMap((a) => [formatAlert(a), ""])].join("\n");
        options.onStatus?.(message);

        if (!options.dryRun) {
          await writeFile(join(alertDir, "latest_alert.txt"), message, "utf8");
          await writeAlertsJsonl(alerts);

          const confluenceWindow = Number(dotGet(config, "alerts.confluence_window_seconds", 900)) || 900;
          for (const alert of alerts) {
            const sym = alert.asset || alert.title.split(/\s+/)[0] || "";
            await store.recordSignal(rule.ruleKey, sym, directionLabel(alert), alert.severity);
            if (alert.severity === "info") {
              const confluence = await store.checkConfluence(sym, confluenceWindow);
              const other = confluence.filter((c) => c.ruleKey !== rule.ruleKey);
              if (other.length) {
                const curDir = directionLabel(alert);
                if (!other.some((c) => c.direction !== curDir)) {
                  const hasShrink = other.every((c) => c.volState === "shrink");
                  if (!hasShrink) {
                    alert.severity = "warning";
                    alert.detail += `\n🔗 多指标共振: ${other.map((c) => c.ruleKey).join(", ")}`;
                  }
                }
              }
            }
          }

          if (options.pushTg) {
            const tgAlerts = await filterTgWorthy(alerts);
            if (tgAlerts.length) {
              const header = `🔔 交易告警 — ${formatDisplayTime(new Date(), "hm")}`;
              const chunks = chunkAlertMessages(
                tgAlerts.map((a) => ({ format: () => formatAlert(a) })),
                header
              );
              for (const chunk of chunks) {
                await sendTelegram(chunk, config);
              }
            }
          }
        }
      } else {
        options.onStatus?.(`[${formatDisplayTime(new Date(), "hm")}] ${rule.name} 监控中... 无告警`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.onStatus?.(`规则 ${rule.ruleKey} 异常: ${msg}`);
      await store.update((s) => {
        s.heartbeats[rule.ruleKey] = {
          ruleName: rule.name,
          lastCheck: Date.now() / 1000,
          status: "error",
          durationMs: 0
        };
      });
    }

    if (options.runOnce) break;
    await new Promise((r) => setTimeout(r, pollSeconds * 1000));
  }
}