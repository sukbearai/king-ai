import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan, parseArgs } from "../scripts/upload.mjs";

const uploadScript = fileURLToPath(new URL("../scripts/upload.mjs", import.meta.url));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "file-kiwi-upload-test-"));
  const file = path.join(root, "sample.txt");
  writeFileSync(file, "sample\n", { mode: 0o600 });
  return { file, root };
}

test("dry-run resolves an explicitly selected regular file without confirmation", () => {
  const { file, root } = fixture();
  const plan = buildPlan(parseArgs(["--dry-run", "--state-dir", path.join(root, "state"), "--", file]));

  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].path, realpathSync(file));
  assert.equal(plan.files[0].size, 7);
});

test("upload mode fails closed without explicit external-transfer confirmation", () => {
  const { file } = fixture();

  assert.throws(() => buildPlan(parseArgs(["--", file])), /External upload is not confirmed/);
});

test("directories and implicit recursive upload are rejected", () => {
  const { root } = fixture();
  const directory = path.join(root, "folder");
  mkdirSync(directory);

  assert.throws(() => buildPlan(parseArgs(["--dry-run", "--", directory])), /Not a regular file/);
});

test("resume requires an existing private state file", () => {
  const { root } = fixture();

  assert.throws(
    () => buildPlan(parseArgs(["--confirm-external-upload", "--state-dir", root, "--resume", "missing"])),
    /Resume state not found/,
  );
});

test("confirmed execution pins the official registry and API endpoint", () => {
  const { file, root } = fixture();
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const captureFile = path.join(root, "capture.json");
  mkdirSync(binDir);
  const fakeNpm = path.join(binDir, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.FILE_KIWI_TEST_CAPTURE, JSON.stringify({
  api: process.env.FILEKIWI_API,
  argv: process.argv.slice(2),
}));
`,
  );
  chmodSync(fakeNpm, 0o755);

  const result = spawnSync(
    process.execPath,
    [uploadScript, "--confirm-external-upload", "--state-dir", stateDir, "--", file],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FILE_KIWI_TEST_CAPTURE: captureFile,
        FILEKIWI_API: "https://example.invalid",
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const capture = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.equal(capture.api, "https://api.file.kiwi");
  assert.ok(capture.argv.includes("--registry=https://registry.npmjs.org"));
  assert.ok(capture.argv.includes("--package=@file-kiwi/node@1.0.9"));
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
});
