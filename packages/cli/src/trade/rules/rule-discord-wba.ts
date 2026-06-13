import { createHash } from "node:crypto";
import { createAlert, type Alert, type AlertRule, type AlertState } from "../alert-rule.js";
import { nowDisplay, runOpencli } from "../data-helpers.js";

const SERVER_ID = "907214708581466112";
const CHANNEL_ID = "1049250383068926022";
const CHANNEL_URL = `https://discord.com/channels/${SERVER_ID}/${CHANNEL_ID}`;
const TARGET_AUTHOR = "王不爱";

async function readDiscordMessages(count = 20): Promise<Array<Record<string, string>>> {
  try {
    const check = await runOpencli(["browser", "eval", "window.location.href"], 10_000);
    const currentUrl = Array.isArray(check) && check[0] && typeof check[0] === "object"
      ? String((check[0] as Record<string, unknown>).stdout ?? "")
      : "";
    if (!currentUrl.includes(CHANNEL_ID)) {
      await runOpencli(["browser", "open", CHANNEL_URL], 15_000);
      await new Promise((r) => setTimeout(r, 3000));
    }
  } catch {
    // non-fatal
  }

  const js = `(function() {
  const msgs = [];
  document.querySelectorAll('[id^="chat-messages-"] > div, [class*="messageListItem"]').forEach(m => {
    const author = (m.querySelector('[class*="username"]') || {}).textContent || '';
    const content = (m.querySelector('[id^="message-content-"]') || {}).textContent || '';
    const timeEl = m.querySelector('time');
    const ts = timeEl ? timeEl.getAttribute('datetime') : '';
    if (content) msgs.push(JSON.stringify({author: author.trim(), time: ts, content: content.trim().slice(0, 500)}));
  });
  return '[' + msgs.slice(-${count}).join(',') + ']';
})()`;

  try {
    const rows = await runOpencli(["browser", "eval", js], 30_000);
    if (!rows.length) return [];
    const raw = rows.map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") return String((r as Record<string, unknown>).stdout ?? JSON.stringify(r));
      return "";
    }).join("\n");
    const jsonStart = raw.indexOf("[");
    if (jsonStart < 0) return [];
    const parsed = JSON.parse(raw.slice(jsonStart)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((m) => {
      if (typeof m === "string") return JSON.parse(m) as Record<string, string>;
      return m as Record<string, string>;
    });
  } catch {
    return [];
  }
}

export function createRuleDiscordWba(): AlertRule {
  const seenHashes = new Set<string>();

  return {
    name: "discord_wba",
    ruleKey: "discord_wba",
    defaultCooldown: 300,
    async check(state: AlertState): Promise<Alert[]> {
      const alerts: Alert[] = [];
      const messages = await readDiscordMessages(20);
      if (!messages.length) return alerts;

      for (const msg of messages) {
        const author = msg.author ?? "";
        const content = msg.content ?? "";
        const ts = msg.time ?? "";
        if (!author.includes(TARGET_AUTHOR)) continue;

        const msgHash = createHash("md5").update(`${ts}_${content.slice(0, 100)}`).digest("hex").slice(0, 12);
        if (seenHashes.has(msgHash)) continue;
        seenHashes.add(msgHash);

        const alertKey = `wba_${msgHash}`;
        if (!state.canAlert(alertKey, 86400)) continue;

        alerts.push(createAlert({
          rule: "王不爱喊单",
          severity: "warning",
          title: `王不爱: ${content.slice(0, 60)}`,
          detail: `频道: 尊享財富密碼\n时间: ${ts}\n\n${content}`,
          timestamp: nowDisplay(),
          direction: 0,
          strength: 0.8,
          asset: "BTC"
        }));
      }

      if (seenHashes.size > 200) {
        const keep = [...seenHashes].slice(-100);
        seenHashes.clear();
        for (const h of keep) seenHashes.add(h);
      }

      return alerts;
    }
  };
}