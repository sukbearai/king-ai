export interface PumpfunFilterConfig {
  minMarketCapUsd?: number;
  minHolders?: number;
  minVolumeUsd1h?: number;
  maxTop10HoldingsPercent?: number;
}

const PUMPFUN_CLI_FLAG_MAP: Array<{ key: string; flag: string }> = [
  { key: "min_market_cap_usd", flag: "--min-market-cap" },
  { key: "max_market_cap_usd", flag: "--max-market-cap" },
  { key: "min_holders", flag: "--min-holders" },
  { key: "max_holders", flag: "--max-holders" },
  { key: "min_volume_usd", flag: "--min-volume" },
  { key: "max_volume_usd", flag: "--max-volume" },
  { key: "min_tx_count", flag: "--min-tx-count" },
  { key: "max_tx_count", flag: "--max-tx-count" },
  { key: "min_bonding_percent", flag: "--min-bonding-percent" },
  { key: "max_bonding_percent", flag: "--max-bonding-percent" },
  { key: "max_top10_holdings_percent", flag: "--max-top10-holdings-percent" },
  { key: "min_token_age", flag: "--min-token-age" },
  { key: "max_token_age", flag: "--max-token-age" },
  { key: "has_at_least_one_social_link", flag: "--has-at-least-one-social-link" },
  { key: "has_x", flag: "--has-x" },
  { key: "has_telegram", flag: "--has-telegram" },
  { key: "has_website", flag: "--has-website" }
];

const LEADERBOARD_CLI_FLAG_MAP: Array<{ key: string; flag: string }> = [
  { key: "min_realized_pnl_usd", flag: "--min-realized-pnl-usd" },
  { key: "max_realized_pnl_usd", flag: "--max-realized-pnl-usd" },
  { key: "min_win_rate_percent", flag: "--min-win-rate-percent" },
  { key: "max_win_rate_percent", flag: "--max-win-rate-percent" },
  { key: "min_txs", flag: "--min-txs" },
  { key: "max_txs", flag: "--max-txs" },
  { key: "min_tx_volume", flag: "--min-tx-volume" },
  { key: "max_tx_volume", flag: "--max-tx-volume" },
  { key: "wallet_type", flag: "--wallet-type" }
];

export function extractOnchainosRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data;
  }
  return [];
}

export function buildOnchainosFilterArgs(
  ds: Record<string, unknown>,
  mappings: Array<{ key: string; flag: string }>
): string[] {
  const args: string[] = [];
  for (const { key, flag } of mappings) {
    const val = ds[key];
    if (val === undefined || val === null || val === "") continue;
    args.push(flag, String(val));
  }
  return args;
}

export function buildPumpfunCliArgs(ds: Record<string, unknown>): string[] {
  const chain = String(ds.chain ?? "solana");
  const stage = String(ds.stage ?? "MIGRATED");
  return [
    "memepump", "tokens",
    "--chain", chain,
    "--stage", stage,
    ...buildOnchainosFilterArgs(ds, PUMPFUN_CLI_FLAG_MAP)
  ];
}

export function buildLeaderboardCliArgs(chain: string, ds: Record<string, unknown>): string[] {
  const timeFrame = String(ds.time_frame ?? "1");
  const sortBy = String(ds.sort_by ?? "1");
  return [
    "leaderboard", "list",
    "--chain", chain,
    "--time-frame", timeFrame,
    "--sort-by", sortBy,
    ...buildOnchainosFilterArgs(ds, LEADERBOARD_CLI_FLAG_MAP)
  ];
}

export function parsePumpfunFilters(ds: Record<string, unknown>): PumpfunFilterConfig {
  return {
    minMarketCapUsd: numberOrUndefined(ds.min_market_cap_usd) ?? 10_000,
    minHolders: numberOrUndefined(ds.min_holders) ?? 50,
    minVolumeUsd1h: numberOrUndefined(ds.min_volume_usd_1h) ?? 50,
    maxTop10HoldingsPercent: numberOrUndefined(ds.max_top10_holdings_percent) ?? 90
  };
}

export function passesPumpfunFilters(
  token: Record<string, unknown>,
  filters: PumpfunFilterConfig
): boolean {
  const market = (token.market ?? {}) as Record<string, string>;
  const tags = (token.tags ?? {}) as Record<string, string>;

  const mcap = Number.parseFloat(market.marketCapUsd ?? "");
  if (filters.minMarketCapUsd !== undefined) {
    if (!Number.isFinite(mcap) || mcap < filters.minMarketCapUsd) return false;
  }

  const holders = Number.parseInt(tags.totalHolders ?? "", 10);
  if (filters.minHolders !== undefined) {
    if (!Number.isFinite(holders) || holders < filters.minHolders) return false;
  }

  const vol1h = Number.parseFloat(market.volumeUsd1h ?? "");
  if (filters.minVolumeUsd1h !== undefined) {
    if (!Number.isFinite(vol1h) || vol1h < filters.minVolumeUsd1h) return false;
  }

  const top10 = Number.parseFloat(tags.top10HoldingsPercent ?? "");
  if (filters.maxTop10HoldingsPercent !== undefined && Number.isFinite(top10)) {
    if (top10 > filters.maxTop10HoldingsPercent) return false;
  }

  return true;
}

export function shortenAddress(address: string): string {
  const trimmed = address.trim();
  if (trimmed.length <= 16) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-6)}`;
}

export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

export function formatPumpfunToken(token: Record<string, unknown>, index: number): string {
  const name = String(token.name ?? "Unknown");
  const symbol = String(token.symbol ?? "?");
  const market = (token.market ?? {}) as Record<string, string>;
  const tags = (token.tags ?? {}) as Record<string, string>;
  const social = (token.social ?? {}) as Record<string, string>;
  const addr = String(token.tokenAddress ?? "");

  const mcap = formatCompactUsd(Number.parseFloat(market.marketCapUsd ?? ""));
  const vol1h = formatCompactUsd(Number.parseFloat(market.volumeUsd1h ?? ""));
  const holders = tags.totalHolders ?? "?";
  const top10Raw = Number.parseFloat(tags.top10HoldingsPercent ?? "");
  const top10 = Number.isFinite(top10Raw) ? `${top10Raw.toFixed(1)}%` : "?";

  const bondingRaw = Number.parseFloat(String(token.bondingPercent ?? ""));
  const bonding = Number.isFinite(bondingRaw) && bondingRaw > 0
    ? ` · 曲线 ${bondingRaw.toFixed(1)}%`
    : "";

  const socialBits: string[] = [];
  if (social.x) socialBits.push("X");
  if (social.telegram) socialBits.push("TG");
  if (social.website) socialBits.push("站");
  const socialStr = socialBits.length ? ` · ${socialBits.join("/")}` : "";

  let line = `${index}. ${name} ($${symbol}) — 市值 ${mcap} · 1h量 ${vol1h} · 持有人 ${holders} · Top10 ${top10}${bonding}${socialStr}`;
  if (addr) line += `\n   ${shortenAddress(addr)}`;
  return line;
}

export function formatLeaderboardEntry(entry: Record<string, unknown>, index: number): string {
  const wallet = String(entry.walletAddress ?? "");
  const shortWallet = shortenAddress(wallet);
  const pnlUsd = Number.parseFloat(String(entry.realizedPnlUsd ?? ""));
  const pnlPct = Number.parseFloat(String(entry.realizedPnlPercent ?? ""));
  const winRate = Number.parseFloat(String(entry.winRatePercent ?? ""));
  const txs = entry.txs ?? "?";
  const volume = Number.parseFloat(String(entry.txVolume ?? ""));

  const topTokens = ((entry.topPnlTokenList as unknown[]) ?? [])
    .slice(0, 3)
    .map((raw) => {
      const tok = raw as Record<string, string>;
      const sym = tok.tokenSymbol ?? "?";
      const pct = Number.parseFloat(tok.tokenPnLPercent ?? "");
      const usd = Number.parseFloat(tok.tokenPnLUsd ?? "");
      const pctStr = Number.isFinite(pct) ? `${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%` : "?";
      const usdStr = Number.isFinite(usd) ? formatCompactUsd(usd) : "?";
      return `${sym} ${pctStr} (${usdStr})`;
    })
    .join(", ");

  const pnlUsdStr = Number.isFinite(pnlUsd) ? formatCompactUsd(pnlUsd) : "N/A";
  const pnlPctStr = Number.isFinite(pnlPct) ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : "";
  const winStr = Number.isFinite(winRate) ? `${winRate.toFixed(0)}%` : "?";
  const volStr = Number.isFinite(volume) ? formatCompactUsd(volume) : "?";

  let line = `${index}. ${shortWallet} — PnL ${pnlUsdStr}${pnlPctStr} · 胜率 ${winStr} · ${txs}笔 · 量 ${volStr}`;
  if (topTokens) line += `\n   最佳: ${topTokens}`;
  return line;
}

export function formatPumpfunSection(
  data: unknown,
  ds: Record<string, unknown>
): { stage: string; lines: string[] } {
  const stage = String(ds.stage ?? "MIGRATED");
  const limit = Number(ds.limit) || 5;
  const filters = parsePumpfunFilters(ds);
  const rows = extractOnchainosRows(data)
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .filter((row) => passesPumpfunFilters(row, filters));

  return {
    stage,
    lines: rows.slice(0, limit).map((row, i) => formatPumpfunToken(row, i + 1))
  };
}

export function formatLeaderboardSection(
  data: unknown,
  limit: number
): string[] {
  return extractOnchainosRows(data)
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    .slice(0, limit)
    .map((row, i) => formatLeaderboardEntry(row, i + 1));
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}