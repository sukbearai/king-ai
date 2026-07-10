import { okxGet } from "./data-helpers.js";

type OkxCandle = [string, string, string, string, string, ...string[]];

export async function fetchOkxCandles(instId: string, bar = "1H", limit = 30): Promise<OkxCandle[]> {
  const body = await okxGet("/api/v5/market/candles", { instId, bar, limit: String(limit) }, 5_000);
  const data = body.data;
  return Array.isArray(data) ? (data as OkxCandle[]) : [];
}

export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
