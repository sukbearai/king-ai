import assert from "node:assert/strict";
import { test } from "node:test";
import {
  listLegacyTradeAgentPlists,
  resolveTradeDaemonProgramArgs,
  shouldKillTradeDaemonCommand,
  tradeDaemonLogPath,
  tradeServiceNames
} from "../src/trade/service.js";
import { TRADE_SERVICE_LABEL } from "../src/paths.js";

test("tradeServiceNames uses king-ai package and trade service label", () => {
  const names = tradeServiceNames();
  assert.equal(names.packageName, "@suwujs/king-ai");
  assert.equal(names.serviceLabel, TRADE_SERVICE_LABEL);
  assert.equal(names.displayName, "King AI Trade");
});

test("tradeDaemonLogPath points under ~/.king-ai/trade/logs", () => {
  assert.match(tradeDaemonLogPath(), /\/\.king-ai\/trade\/logs\/daemon\.log$/);
});

test("shouldKillTradeDaemonCommand only matches active foreground trade daemon runs", () => {
  assert.equal(shouldKillTradeDaemonCommand("node dist/cli.js trade daemon --push-tg"), true);
  assert.equal(shouldKillTradeDaemonCommand("tsx src/cli.ts trade daemon"), true);
  assert.equal(shouldKillTradeDaemonCommand("node dist/cli.js trade install-service"), false);
  assert.equal(shouldKillTradeDaemonCommand("npx -y @suwujs/king-ai@latest trade daemon --push-tg"), false);
  assert.equal(shouldKillTradeDaemonCommand("node dist/cli.js trade alert run a"), false);
});

test("resolveTradeDaemonProgramArgs prefers explicit cli path", () => {
  const args = resolveTradeDaemonProgramArgs({ cliPath: "/tmp/king-ai-cli.js", pushTg: true });
  assert.deepEqual(args.slice(0, 3), [process.execPath, "/tmp/king-ai-cli.js", "trade"]);
  assert.equal(args.at(-1), "--push-tg");
});

test("listLegacyTradeAgentPlists returns sorted com.trade-agent.* plist paths when present", () => {
  const plists = listLegacyTradeAgentPlists();
  for (const path of plists) {
    assert.match(path, /com\.trade-agent\..+\.plist$/);
  }
  const labels = plists.map((path) => path.split("/").pop() ?? "");
  assert.deepEqual(labels, [...labels].sort());
});