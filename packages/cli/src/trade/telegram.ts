import type { TradeConfig } from "./config.js";
import { loadTradeConfig, telegramFromConfig } from "./config.js";

export const TG_MAX_LEN = 4000;

export function chunkTelegramMessage(text: string, maxLen = TG_MAX_LEN): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split("\n\n");
  let current = "";
  for (const para of paragraphs) {
    const piece = current ? `\n\n${para}` : para;
    if (current && current.length + piece.length > maxLen) {
      chunks.push(current.trimEnd());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trimEnd());

  const repacked: string[] = [];
  for (const ch of chunks) {
    if (ch.length <= maxLen) {
      repacked.push(ch);
      continue;
    }
    let buf = "";
    for (const line of ch.split("\n")) {
      if (line.length + 1 > maxLen) {
        if (buf.trim()) {
          repacked.push(buf.trimEnd());
          buf = "";
        }
        for (let i = 0; i < line.length; i += maxLen) {
          repacked.push(line.slice(i, i + maxLen));
        }
        continue;
      }
      if (buf.length + line.length + 1 > maxLen && buf) {
        repacked.push(buf.trimEnd());
        buf = `${line}\n`;
      } else {
        buf += `${line}\n`;
      }
    }
    if (buf.trim()) repacked.push(buf.trimEnd());
  }

  if (!repacked.length) {
    for (let i = 0; i < text.length; i += maxLen) {
      repacked.push(text.slice(i, i + maxLen));
    }
  }
  return repacked;
}

async function sendChunk(botToken: string, chatId: string, text: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = new URLSearchParams({ chat_id: chatId, text });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return true;
    } catch {
      // retry
    }
    if (attempt < 4) {
      const backoff = Math.min(90, 5 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, backoff * 1000));
    }
  }
  return false;
}

export async function sendTelegram(text: string, config?: TradeConfig): Promise<boolean> {
  const cfg = config ?? (await loadTradeConfig());
  const { botToken, chatId } = telegramFromConfig(cfg);
  if (!botToken || !chatId) return false;

  const chunks = chunkTelegramMessage(text);
  let success = true;
  for (const chunk of chunks) {
    const ok = await sendChunk(botToken, chatId, chunk);
    if (!ok) success = false;
  }
  return success;
}

export function formatAlertTelegramMessage(alerts: Array<{ format(): string }>, header: string): string {
  const parts = [`${header}\n`];
  for (const alert of alerts) {
    parts.push(alert.format());
    parts.push("");
  }
  return parts.join("\n");
}

export function chunkAlertMessages(alerts: Array<{ format(): string }>, header: string, maxLen = TG_MAX_LEN): string[] {
  const full = formatAlertTelegramMessage(alerts, header);
  if (full.length <= maxLen) return [full];

  const chunks: string[] = [];
  let current = `${header}\n\n`;
  for (const alert of alerts) {
    const block = `${alert.format()}\n\n`;
    if (current.length + block.length > maxLen) {
      chunks.push(current.trimEnd());
      current = `🔔 告警续 (${chunks.length + 1})\n\n`;
    }
    current += block;
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}
