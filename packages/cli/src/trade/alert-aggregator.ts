import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SIGNAL_ALERT_LOG_PATH, TRADE_ALERT_DIR } from "../paths.js";
import { sendTelegram } from "./telegram.js";
import { formatDisplayTime } from "./time-utils.js";

const COOLDOWN_FILE = join(TRADE_ALERT_DIR, "agg_cooldowns.json");
const CORRELATION_COOLDOWN = 14_400;

const RISK_GROUPS: Record<string, { rules: Set<string>; minTriggers: number; label: string; what: string; action: string }> = {
  crypto_stress: {
    rules: new Set(["价格异动", "资金费率", "多空比", "稳定币大额", "大户转账", "均线跌破"]),
    minTriggers: 3,
    label: "加密市场系统性风险",
    what: "加密市场多个指标同时恶化，可能要出大事",
    action: "有仓位的话减一半，没仓位别抄底，等稳了再说"
  },
  smart_money_convergence: {
    rules: new Set(["聪明钱", "Meme 大额", "大户转账"]),
    minTriggers: 2,
    label: "聪明钱信号聚合",
    what: "多个大资金钱包同时在买入，可能在提前布局",
    action: "看看他们买的是什么币，记下来观察，别急着跟"
  },
  macro_shock: {
    rules: new Set(["VIX 飙升", "价格异动", "股票异动"]),
    minTriggers: 2,
    label: "宏观冲击",
    what: "恐慌指数飙升 + 股票/加密同时大跌，可能有突发大事件",
    action: "风险资产先减仓避险，等新闻出来看清楚再操作"
  },
  event_driven: {
    rules: new Set(["Polymarket", "股票异动", "期权异常"]),
    minTriggers: 2,
    label: "事件驱动异动",
    what: "有人在多个市场同时下重注，可能提前知道了什么消息",
    action: "检查你的持仓有没有风险，关注接下来的新闻"
  }
};

async function readRecentAlerts(windowSeconds: number): Promise<Array<Record<string, unknown>>> {
  let text: string;
  try {
    text = await readFile(SIGNAL_ALERT_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - windowSeconds * 1000;
  const alerts: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as Record<string, unknown>;
      const ts = new Date(String(entry.timestamp ?? ""));
      if (Number.isNaN(ts.getTime()) || ts.getTime() < cutoff) continue;
      alerts.push(entry);
    } catch {
      continue;
    }
  }
  return alerts;
}

async function loadCooldowns(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(COOLDOWN_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

async function saveCooldowns(cooldowns: Record<string, number>): Promise<void> {
  await writeFile(COOLDOWN_FILE, `${JSON.stringify(cooldowns, null, 2)}\n`, "utf8");
}

export async function runAlertAggregator(options: {
  windowSeconds?: number;
  pushTg?: boolean;
  dryRun?: boolean;
} = {}): Promise<string[]> {
  const windowSeconds = options.windowSeconds ?? 600;
  const alerts = await readRecentAlerts(windowSeconds);
  const triggered = new Set(alerts.map((a) => String(a.rule ?? "")));
  const cooldowns = await loadCooldowns();
  const now = Date.now() / 1000;
  const messages: string[] = [];

  for (const [groupKey, group] of Object.entries(RISK_GROUPS)) {
    const overlap = [...group.rules].filter((r) => triggered.has(r));
    if (overlap.length < group.minTriggers) continue;
    if (now - (cooldowns[groupKey] ?? 0) < CORRELATION_COOLDOWN) continue;
    cooldowns[groupKey] = now;

    const msg = [
      `⚡ ${group.label}`,
      `发生了什么: ${group.what}`,
      `你该怎么做: ${group.action}`,
      `触发规则: ${overlap.join(", ")}`
    ].join("\n");
    messages.push(msg);

    if (options.pushTg && !options.dryRun) {
      await sendTelegram(`🚨 关联告警 — ${formatDisplayTime()}\n\n${msg}`);
    }
  }

  if (messages.length) await saveCooldowns(cooldowns);
  return messages;
}