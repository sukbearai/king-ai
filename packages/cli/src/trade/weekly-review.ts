import { AccuracyTracker, type DriftEntry, type RuleStats } from "./accuracy-tracker.js";
import { loadTradeConfig } from "./config.js";
import { sendTelegram } from "./telegram.js";

function trendArrow(delta: number | null): string {
  if (delta == null) return "—";
  if (delta >= 5) return `📈+${delta.toFixed(0)}pp`;
  if (delta <= -5) return `📉${delta.toFixed(0)}pp`;
  return `➡️${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp`;
}

export function buildDriftReport(drifts: DriftEntry[]): string {
  if (!drifts.length) return "";
  const lines = ["🚨 信号命中率断崖预警 (7d vs 30d, min n=10)", ""];
  for (const d of drifts) {
    lines.push(
      `🔴 ${d.rule}: ${d.baseline_rate.toFixed(0)}% → ${d.recent_rate.toFixed(0)}% `
      + `(${d.delta_pp >= 0 ? "+" : ""}${d.delta_pp.toFixed(0)}pp)  `
      + `[n7=${d.recent_n}, n30=${d.baseline_n}]`
    );
  }
  lines.push("", "建议检查: 告警方向是否反向？阈值是否过松？市场模式切换？");
  return lines.join("\n");
}

export function buildWeeklyReport(recent: RuleStats[], baseline: RuleStats[], drifts: DriftEntry[]): string {
  const bMap = new Map(baseline.map((s) => [s.rule, s]));
  const lines = ["📊 信号质量周报 — 7d vs 30d 基线", ""];
  lines.push(`${"规则".padEnd(12)} ${"7d Rate".padStart(8)} ${"n".padStart(4)} ${"趋势".padStart(11)} ${"Avg%".padStart(7)}`);
  lines.push("─".repeat(46));
  for (const s of [...recent].sort((a, b) => (b.validated ?? 0) - (a.validated ?? 0))) {
    if ((s.validated ?? 0) < 3) continue;
    const b = bMap.get(s.rule);
    const rate = s.hit_rate != null ? `${s.hit_rate.toFixed(0)}%` : "—";
    const delta = b && s.hit_rate != null && b.hit_rate != null ? s.hit_rate - b.hit_rate : null;
    const pct = s.avg_pct != null ? `${s.avg_pct >= 0 ? "+" : ""}${s.avg_pct.toFixed(1)}%` : "—";
    lines.push(
      `${s.rule.padEnd(12)} ${rate.padStart(8)} ${String(s.validated).padStart(4)} `
      + `${trendArrow(delta).padStart(11)} ${pct.padStart(7)}`
    );
  }
  const totalV = recent.reduce((a, s) => a + (s.validated ?? 0), 0);
  const totalH = recent.reduce((a, s) => a + (s.hits ?? 0), 0);
  const overall = totalV ? Math.round((totalH / totalV) * 1000) / 10 : 0;
  lines.push("", `Overall 7d: ${totalH}/${totalV} = ${overall}%`);
  if (drifts.length) {
    lines.push("", buildDriftReport(drifts));
  }
  return lines.join("\n");
}

export async function runWeeklyReview(options: {
  weekly?: boolean;
  driftOnly?: boolean;
  pushTg?: boolean;
  dryRun?: boolean;
} = {}): Promise<string> {
  const tracker = new AccuracyTracker();
  await tracker.ingestAlerts();
  await tracker.validatePending();
  const drifts = tracker.detectDrift();
  const isMonday = new Date().getDay() === 1;

  let report = "";
  if (options.driftOnly) {
    if (drifts.length) report = buildDriftReport(drifts);
  } else if (options.weekly || isMonday) {
    report = buildWeeklyReport(
      tracker.getRuleStats(7, "6h"),
      tracker.getRuleStats(30, "6h", 7),
      drifts
    );
  } else if (drifts.length) {
    report = buildDriftReport(drifts);
  }

  if (!report) {
    process.stderr.write("[weekly-review] no drift and not Monday — skip\n");
    return "";
  }

  process.stdout.write(`${report}\n`);
  if (options.dryRun || !options.pushTg) return report;

  const config = await loadTradeConfig();
  await sendTelegram(report, config);
  return report;
}