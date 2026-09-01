import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const gmgnPath = resolve(root, "packages/cli/src/trade/robinhood-chain-gmgn.ts");
const phase2Path = resolve(root, "packages/cli/src/trade/robinhood-chain-phase2.ts");
const originals = new Map([
  [gmgnPath, readFileSync(gmgnPath, "utf8")],
  [phase2Path, readFileSync(phase2Path, "utf8")],
]);

const focused = [
  "pnpm",
  ["--filter", "@suwujs/king-ai", "build"],
  "node",
  [
    "--test",
    "packages/cli/dist/test/robinhood-chain-gmgn.test.js",
    "packages/cli/dist/test/robinhood-chain-phase2.test.js",
  ],
];

function replaceExact(path, before, after, expectedCount = 1) {
  const source = readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`mutation source mismatch: ${path} expected ${expectedCount} matches, found ${count}`);
  }
  writeFileSync(path, source.split(before).join(after), "utf8");
}

function restore() {
  for (const [path, source] of originals) writeFileSync(path, source, "utf8");
}

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function runFocused() {
  const build = run(focused[0], focused[1]);
  if (build.status !== 0) return build;
  return run(focused[2], focused[3]);
}

const mutants = [
  {
    name: "rpc-address-limit-20-to-21",
    apply: () =>
      replaceExact(
        gmgnPath,
        "const maxAddresses = Math.min(20, Math.max(1, Math.trunc(options.maxAddresses ?? 20)));",
        "const maxAddresses = Math.min(21, Math.max(1, Math.trunc(options.maxAddresses ?? 20)));",
      ),
  },
  {
    name: "accept-chain-id-prefix-with-invalid-suffix",
    apply: () =>
      replaceExact(
        gmgnPath,
        "    chainValid = matchesRobinhoodChainId(chainId);",
        '    chainValid = typeof chainId === "string" && Number.parseInt(chainId, 16) === ROBINHOOD_CHAIN_ID;',
      ),
  },
  {
    name: "count-timestamp-refresh-against-retry-budget",
    apply: () =>
      replaceExact(
        gmgnPath,
        "        await this.ensureClock(signal, true);\n        attempt -= 1;\n        continue;",
        "        await this.ensureClock(signal, true);\n        continue;",
      ),
  },
  {
    name: "allow-missing-nested-trending-status",
    apply: () =>
      replaceExact(
        gmgnPath,
        "  if (!explicitSuccess(outer?.code) || !explicitSuccess(inner?.code) || !Array.isArray(data?.rank)) {",
        "  if (!explicitSuccess(outer?.code) || !Array.isArray(data?.rank)) {",
      ),
  },
  {
    name: "starve-later-trenches-categories",
    apply: () =>
      replaceExact(
        gmgnPath,
        "      if (categoryCount >= hardLimit) break;",
        "      if (observations.length >= hardLimit) return observations;",
      ),
  },
  {
    name: "ignore-rpc-verification-cancellation",
    apply: () =>
      replaceExact(
        gmgnPath,
        '        if (signal?.aborted) throw new Error("gmgn_request_aborted");\n        // Try the next bounded endpoint.',
        "        // Try the next bounded endpoint.",
      ),
  },
  {
    name: "allow-unknown-honeypot-status",
    apply: () =>
      replaceExact(
        gmgnPath,
        'if (fiveMinute.isHoneypot == null) reasons.push("honeypot_status_unknown");',
        'if (false) reasons.push("honeypot_status_unknown");',
      ),
  },
  {
    name: "materialize-unverified-gmgn-candidates",
    apply: () =>
      replaceExact(
        phase2Path,
        "WHERE state='qualified' AND verified=1 AND window_start>=? AND field_run_revision=?",
        "WHERE state='qualified' AND verified>=0 AND window_start>=? AND field_run_revision=?",
        2,
      ),
  },
];

try {
  for (const mutant of mutants) {
    restore();
    mutant.apply();
    const result = runFocused();
    if (result.status === 0) throw new Error(`surviving mutant: ${mutant.name}`);
    process.stdout.write(`killed ${mutant.name}\n`);
  }
} finally {
  restore();
}

for (const [path, source] of originals) {
  if (readFileSync(path, "utf8") !== source) throw new Error(`failed to restore ${path}`);
}

const clean = runFocused();
if (clean.status !== 0) {
  process.stderr.write(clean.stdout ?? "");
  process.stderr.write(clean.stderr ?? "");
  process.exit(clean.status ?? 1);
}
process.stdout.write("clean focused suite passed after restoration\n");
