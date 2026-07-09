import { classifyCelebritySearchSnapshot, type CelebrityVerifyResult } from "./celebrity-search.js";
import { dotGet, loadTradeConfig, type TradeConfig } from "./config.js";
import { runOpencli } from "./data-helpers.js";
import { formatDisplayTime } from "./time-utils.js";
import { verifyStepTimeoutMs, withVerifyTimeout } from "./verify-signals.js";

export {
  classifyCelebritySearchSnapshot,
  type CelebritySearchSnapshot,
  type CelebrityVerifyResult,
  type CelebrityVerifyStatus,
} from "./celebrity-search.js";

const TWITTER_SEARCH_SESSION = "trade-twitter-search";

export function celebrityAccountsFromConfig(config: TradeConfig): string[] {
  const cfg = (dotGet(config, "alerts.celebrity_tweet", {}) ?? {}) as Record<string, unknown>;
  return Array.isArray(cfg.accounts) ? cfg.accounts.map(String).filter(Boolean) : [];
}

async function inspectCelebrityAccount(account: string, timeoutMs: number): Promise<CelebrityVerifyResult> {
  const url = `https://x.com/search?q=${encodeURIComponent(`from:${account}`)}&f=live`;
  const js = `(() => ({
  title: document.title,
  url: location.href,
  text: document.body.innerText.slice(0, 1600),
  articles: document.querySelectorAll('article').length
  }))()`;
  try {
    return await withVerifyTimeout(`celebrity:${account}`, timeoutMs, async () => {
      let lastOpenError = "opencli open failed";
      for (let attempt = 0; attempt < 2; attempt++) {
        await runOpencli(["browser", TWITTER_SEARCH_SESSION, "close"], 10_000);
        const opened = await runOpencli(
          ["browser", TWITTER_SEARCH_SESSION, "--window", "background", "open", url],
          30_000,
        );
        if (!opened.ok) {
          lastOpenError = opened.error ?? lastOpenError;
          continue;
        }
        await runOpencli(["browser", TWITTER_SEARCH_SESSION, "--window", "background", "wait", "time", "5"], 10_000);
        const evalResult = await runOpencli(
          ["browser", TWITTER_SEARCH_SESSION, "--window", "background", "eval", js],
          30_000,
        );
        if (!evalResult.ok) {
          return {
            account,
            status: "error",
            articles: 0,
            title: "",
            url,
            detail: evalResult.error ?? "opencli eval failed",
          };
        }
        const row = evalResult.data.find(
          (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item),
        );
        return classifyCelebritySearchSnapshot(account, row ?? { url });
      }
      return { account, status: "error", articles: 0, title: "", url, detail: lastOpenError };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { account, status: "error", articles: 0, title: "", url, detail: msg };
  }
}

export function formatCelebrityVerifyResults(results: CelebrityVerifyResult[]): string {
  const stamp = formatDisplayTime(new Date(), "hm");
  const lines = [`🧪 名人推文监控验证 — ${stamp}`];
  for (const result of results) {
    const icon = result.status === "ok" || result.status === "no-results" ? "✅" : "❌";
    lines.push(`${icon} @${result.account} ${result.status} — ${result.detail}`);
  }
  const failing = results.filter((result) => !["ok", "no-results"].includes(result.status)).length;
  lines.push("", `summary: ${results.length - failing}/${results.length} readable`);
  return lines.join("\n");
}

export async function runVerifyCelebrity(options: { dryRun?: boolean } = {}): Promise<CelebrityVerifyResult[]> {
  const config = await loadTradeConfig();
  const accounts = celebrityAccountsFromConfig(config);
  const timeoutMs = verifyStepTimeoutMs(config);
  const results: CelebrityVerifyResult[] = [];

  for (const account of accounts) {
    results.push(await inspectCelebrityAccount(account, timeoutMs));
  }

  const output = formatCelebrityVerifyResults(results);
  process.stdout.write(`${output}\n`);
  if (!options.dryRun) {
    process.stderr.write("[verify-celebrity] no Telegram push is sent; this command is browser health only\n");
  }
  if (results.some((result) => !["ok", "no-results"].includes(result.status))) {
    process.exitCode = 1;
  }
  return results;
}
