import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractOnchainosRows,
  formatCompactUsd,
  formatLeaderboardEntry,
  formatLeaderboardSection,
  formatPumpfunSection,
  formatPumpfunToken,
  passesPumpfunFilters,
  parsePumpfunFilters,
  shortenAddress,
} from "../src/trade/morning-brief-onchain.js";

const SAMPLE_PUMP_TOKEN = {
  name: "MEYH CAT",
  symbol: "MEYHCAT",
  tokenAddress: "4Ljjrv3CodNfmTmxRdnvga7bjsfe87zkh7FdPEo9pump",
  bondingPercent: "4.51",
  market: {
    marketCapUsd: "4099.609520217396694073",
    volumeUsd1h: "141.41353022588",
    txCount1h: "4",
  },
  tags: {
    totalHolders: "3",
    top10HoldingsPercent: "51.2014",
  },
  social: {
    x: "",
    telegram: "",
    website: "",
  },
};

const SAMPLE_LEADERBOARD_ENTRY = {
  walletAddress: "5qx7yV4Cwg67iEDSuszwMHYrQDJRnSCDF5DS6ZPAFvnV",
  realizedPnlUsd: "16196.627391554593000000",
  realizedPnlPercent: "130.442952495096205000",
  winRatePercent: "40.0",
  txs: "70",
  txVolume: "33955.684378267184000000",
  topPnlTokenList: [
    {
      tokenSymbol: "TripleT",
      tokenPnLPercent: "239.27374189743676",
      tokenPnLUsd: "13737.95104077069",
    },
  ],
};

describe("formatCompactUsd", () => {
  it("formats large and small values", () => {
    assert.equal(formatCompactUsd(330_845_212.66), "$330.85M");
    assert.equal(formatCompactUsd(16_196.62), "$16.2K");
    assert.equal(formatCompactUsd(0.07205), "$0.0721");
  });
});

describe("passesPumpfunFilters", () => {
  it("rejects low-quality new tokens", () => {
    const filters = parsePumpfunFilters({});
    assert.equal(passesPumpfunFilters(SAMPLE_PUMP_TOKEN, filters), false);
  });

  it("accepts tokens that meet default thresholds", () => {
    const filters = parsePumpfunFilters({});
    const good = {
      ...SAMPLE_PUMP_TOKEN,
      market: { marketCapUsd: "50000", volumeUsd1h: "200" },
      tags: { totalHolders: "120", top10HoldingsPercent: "35" },
    };
    assert.equal(passesPumpfunFilters(good, filters), true);
  });
});

describe("formatPumpfunToken", () => {
  it("renders readable token lines", () => {
    const line = formatPumpfunToken(
      {
        ...SAMPLE_PUMP_TOKEN,
        market: { marketCapUsd: "330845212.66", volumeUsd1h: "15350.35" },
        tags: { totalHolders: "136", top10HoldingsPercent: "9.9751" },
        social: { x: "https://x.com/ntfsofficial", website: "https://ntfs.world/" },
      },
      1,
    );
    assert.match(line, /1\. MEYH CAT \(\$MEYHCAT\)/);
    assert.match(line, /市值 \$330\.85M/);
    assert.match(line, /持有人 136/);
    assert.match(line, /X\/站/);
    assert.match(line, /4Ljjrv3C/);
  });
});

describe("formatLeaderboardEntry", () => {
  it("renders readable wallet summary", () => {
    const line = formatLeaderboardEntry(SAMPLE_LEADERBOARD_ENTRY, 1);
    assert.match(line, /1\. 5qx7yV4C…PAFvnV/);
    assert.match(line, /PnL \$16\.2K/);
    assert.match(line, /胜率 40%/);
    assert.match(line, /最佳: TripleT \+239%/);
  });
});

describe("formatPumpfunSection", () => {
  it("filters junk tokens before formatting", () => {
    const { lines, stage } = formatPumpfunSection({ ok: true, data: [SAMPLE_PUMP_TOKEN] }, { stage: "NEW", limit: 5 });
    assert.equal(stage, "NEW");
    assert.deepEqual(lines, []);
  });
});

describe("formatLeaderboardSection", () => {
  it("extracts rows from onchainos envelope", () => {
    const lines = formatLeaderboardSection({ ok: true, data: [SAMPLE_LEADERBOARD_ENTRY] }, 3);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /5qx7yV4C/);
  });
});

describe("extractOnchainosRows", () => {
  it("unwraps ok/data payloads", () => {
    assert.equal(extractOnchainosRows({ ok: true, data: [1, 2] }).length, 2);
    assert.equal(extractOnchainosRows([3]).length, 1);
  });
});

describe("shortenAddress", () => {
  it("shortens long addresses", () => {
    assert.equal(shortenAddress("4Ljjrv3CodNfmTmxRdnvga7bjsfe87zkh7FdPEo9pump"), "4Ljjrv3C…o9pump");
  });
});
