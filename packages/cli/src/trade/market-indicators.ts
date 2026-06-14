type OkxCandle = [string, string, string, string, string, ...string[]];

export async function fetchOkxCandles(instId: string, bar = "1H", limit = 30): Promise<OkxCandle[]> {
  const url = `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${encodeURIComponent(bar)}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "king-ai/1.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: OkxCandle[] };
    return body.data ?? [];
  } catch {
    return [];
  }
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