import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runTg, summarizeCliFailure } from "../src/trade/data-helpers.js";

test("summarizeCliFailure removes Telethon warnings and caps stderr", () => {
  const err = Object.assign(new Error("Command failed: tg recent"), {
    code: 1,
    stderr: [
      "05:01:12 [telethon.network.connection.connection] WARNING: Server closed the connection: [Errno 32] Broken pipe",
      "Syncing meme链上监控...",
      "authentication failed",
    ].join("\n"),
  });
  const summary = summarizeCliFailure(err);
  assert.equal(summary, "exit=1: authentication failed");

  const long = Object.assign(new Error("Command failed: tg"), {
    code: 1,
    stderr: "z".repeat(5000),
  });
  assert.ok(summarizeCliFailure(long).length <= 1000);
});

test("runTg serializes processes that share the Telethon session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-fake-tg-"));
  const bin = join(dir, "tg");
  const log = join(dir, "calls.log");
  const oldPath = process.env.PATH;
  await writeFile(
    bin,
    [
      `#!${process.execPath}`,
      'const { appendFileSync } = require("node:fs");',
      "const [label, log] = process.argv.slice(2);",
      'appendFileSync(log, "start:" + label + "\\n");',
      'setTimeout(() => { appendFileSync(log, "end:" + label + "\\n"); }, 50);',
    ].join("\n"),
    "utf8",
  );
  await chmod(bin, 0o755);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  try {
    const [first, second] = await Promise.all([runTg(["one", log], 2000), runTg(["two", log], 2000)]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "start:one",
      "end:one",
      "start:two",
      "end:two",
    ]);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});

test("runTg force-kills an uncooperative process at its deadline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-hanging-tg-"));
  const bin = join(dir, "tg");
  const oldPath = process.env.PATH;
  await writeFile(
    bin,
    `#!${process.execPath}\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`,
    "utf8",
  );
  await chmod(bin, 0o755);
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  const started = Date.now();
  try {
    const result = await runTg(["hang"], 50);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /SIGKILL|timed out|failed/i);
    assert.ok(Date.now() - started < 1500);
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
