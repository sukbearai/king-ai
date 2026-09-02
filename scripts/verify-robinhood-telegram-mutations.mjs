import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const phase2Path = resolve(root, "packages/cli/src/trade/robinhood-chain-phase2.ts");
const original = readFileSync(phase2Path, "utf8");

function replaceExact(before, after, expectedCount = 1) {
  const source = readFileSync(phase2Path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`mutation source mismatch: expected ${expectedCount} matches, found ${count}`);
  }
  writeFileSync(phase2Path, source.split(before).join(after), "utf8");
}

function restore() {
  writeFileSync(phase2Path, original, "utf8");
}

function run(command, args) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe" });
}

function runFocused() {
  const build = run("pnpm", ["--filter", "@suwujs/king-ai", "build"]);
  if (build.status !== 0) return build;
  return run("node", [
    "--test",
    "packages/cli/dist/test/robinhood-chain-phase2-telegram.test.js",
    "packages/cli/dist/test/robinhood-chain-phase2.test.js",
  ]);
}

const mutants = [
  {
    name: "shadow-default-becomes-telegram",
    apply: () =>
      replaceExact(
        'const delivery = String(raw.delivery ?? "shadow");',
        'const delivery = String(raw.delivery ?? "telegram");',
      ),
  },
  {
    name: "first-enable-baselines-stale-instead-of-draft",
    apply: () =>
      replaceExact(
        "WHERE field_run_revision=? AND state='draft'\n        ORDER BY first_materialized_at,alert_id",
        "WHERE field_run_revision=? AND state='stale'\n        ORDER BY first_materialized_at,alert_id",
      ),
  },
  {
    name: "delivery-cycle-limit-ten-to-eleven",
    apply: () => replaceExact("if (networkAttempts >= 10) break;", "if (networkAttempts >= 11) break;"),
  },
  {
    name: "retry-ambiguous-unknown",
    apply: () =>
      replaceExact(
        "(d.state='retry_wait' AND d.next_attempt_at<=?)",
        "(d.state IN ('retry_wait','unknown') AND COALESCE(d.next_attempt_at,0)<=?)",
      ),
  },
  {
    name: "bypass-subject-cooldown",
    apply: () =>
      replaceExact(
        "now - Number(cooldown.last_delivered_at) < cfg.telegramSubjectCooldownSeconds",
        "now - Number(cooldown.last_delivered_at) < 0",
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

if (readFileSync(phase2Path, "utf8") !== original) throw new Error("failed to restore Phase 2 source");

const clean = runFocused();
if (clean.status !== 0) {
  process.stderr.write(clean.stdout ?? "");
  process.stderr.write(clean.stderr ?? "");
  process.exit(clean.status ?? 1);
}
process.stdout.write("clean focused suite passed after restoration\n");
