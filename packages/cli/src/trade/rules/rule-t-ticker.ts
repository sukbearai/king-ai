import { TRADE_MENTIONS_DB_PATH } from "../../paths.js";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { dotGet, loadTradeConfig } from "../config.js";
import { nowDisplay, sqliteQuery } from "../data-helpers.js";

export function createRuleTTicker(): AlertRule {
  let minMentions = 3;
  let minViews = 1000;
  let minAuthors = 2;
  let velocityMult = 3;
  let criticalMult = 5;
  let criticalViews = 10_000;
  let criticalAuthors = 3;

  return {
    name: "ticker_mention_velocity",
    ruleKey: "ticker_velocity",
    defaultCooldown: 86400,
    async check(state: AlertState): Promise<Alert[]> {
      const config = await loadTradeConfig();
      const params = (dotGet(config, "alerts.ticker_mention", {}) ?? {}) as Record<string, unknown>;
      minMentions = Number(params.min_mentions ?? 3);
      minViews = Number(params.min_views ?? 1000);
      minAuthors = Number(params.min_authors ?? 2);
      velocityMult = Number(params.velocity_multiplier ?? 3);
      criticalMult = Number(params.critical_multiplier ?? 5);
      criticalViews = Number(params.critical_views ?? 10_000);
      criticalAuthors = Number(params.critical_authors ?? 3);

      const now = Date.now() / 1000;
      const cutoff24h = now - 86400;
      const cutoff24hPriorTo7d = cutoff24h - 86400 * 7;

      const rows = await sqliteQuery(
        TRADE_MENTIONS_DB_PATH,
        `SELECT ticker, COUNT(*) AS cnt_24h, SUM(views) AS views_24h, COUNT(DISTINCT author) AS authors_24h
         FROM ticker_mentions WHERE created_ts >= ${cutoff24h}
         GROUP BY ticker HAVING cnt_24h >= ${minMentions} AND views_24h >= ${minViews} AND authors_24h >= ${minAuthors}
         ORDER BY cnt_24h DESC`,
      );
      if (!rows.length) return [];

      const alerts: Alert[] = [];
      for (const row of rows) {
        const ticker = String(row[0] ?? "");
        const cnt24h = Number(row[1] ?? 0);
        const views24h = Number(row[2] ?? 0);
        const authors24h = Number(row[3] ?? 0);
        if (!ticker) continue;

        const baselineRows = await sqliteQuery(
          TRADE_MENTIONS_DB_PATH,
          `SELECT COUNT(*) FROM ticker_mentions WHERE ticker = '${ticker.replace(/'/g, "''")}'
           AND created_ts >= ${cutoff24hPriorTo7d} AND created_ts < ${cutoff24h}`,
        );
        const baselineTotal = Number(baselineRows[0]?.[0] ?? 0);
        const baselinePerDay = baselineTotal / 7;
        const isFirst = baselineTotal === 0;
        const mult = baselinePerDay > 0 ? cnt24h / baselinePerDay : Infinity;

        let trigger = false;
        let tag = "";
        if (isFirst) {
          trigger = true;
          tag = "首次浮现";
        } else if (mult >= velocityMult) {
          trigger = true;
          tag = `提及加速 ${mult.toFixed(1)}×`;
        }
        if (!trigger) continue;

        // First emergence stays in the audit stream as info (confluence can promote);
        // sustained acceleration next window (baseline > 0) earns warning+.
        let severity: Alert["severity"] = isFirst ? "info" : "warning";
        if (!isFirst && mult >= criticalMult && views24h >= criticalViews && authors24h >= criticalAuthors) {
          severity = "critical";
        }

        const sampleRows = await sqliteQuery(
          TRADE_MENTIONS_DB_PATH,
          `SELECT author, views, substr(text_snippet, 1, 120) FROM ticker_mentions
           WHERE ticker = '${ticker.replace(/'/g, "''")}' AND created_ts >= ${cutoff24h}
           ORDER BY views DESC LIMIT 1`,
        );
        let sampleText = "";
        if (sampleRows[0]) {
          const [a, v, txt] = sampleRows[0];
          sampleText = `\nTop: @${a} (${v}👁) ${txt}…`;
        }

        const alertKey = `ticker_${ticker}`;
        if (state.canAlert(alertKey, 86400)) {
          alerts.push(
            createAlert({
              ruleId: "ticker_velocity",
              severity,
              title: `$${ticker} ${tag} (${cnt24h}条/${authors24h}作者/${views24h.toLocaleString()}👁)`,
              detail: `24h: ${cnt24h} 条 | ${authors24h} 独立作者 | ${views24h.toLocaleString()} views | baseline: ${baselinePerDay.toFixed(1)}/天${sampleText}`,
              timestamp: nowDisplay(),
              direction: 0.5,
              strength: isFirst ? 0.5 : Math.min(mult / 10, 1),
              asset: ticker,
              tags: isFirst ? ["first_seen"] : [],
              cooldownKey: alertKey,
            }),
          );
        }
      }
      return alerts;
    },
  };
}
