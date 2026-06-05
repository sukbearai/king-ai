import assert from "node:assert/strict";
import { test } from "node:test";
import { anyRunnerBusy, doctorExitCode, formatDoctorReport, missingEngineMessage, parsePairLocator, resolveHostName, shouldExitForUpdate } from "../src/daemon.js";

test("anyRunnerBusy reports whether any runner is active", () => {
  assert.equal(anyRunnerBusy([]), false);
  assert.equal(anyRunnerBusy([{ isBusy: false }, { isBusy: false }]), false);
  assert.equal(anyRunnerBusy([{ isBusy: false }, { isBusy: true }]), true);
});

test("shouldExitForUpdate waits for update readiness, idle runners, and no shutdown", () => {
  assert.equal(shouldExitForUpdate({ updateReady: false, shuttingDown: false, anyBusy: false }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: true, anyBusy: false }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: false, anyBusy: true }), false);
  assert.equal(shouldExitForUpdate({ updateReady: true, shuttingDown: false, anyBusy: false }), true);
});

test("resolveHostName avoids localhost and uses platform names on macOS", () => {
  assert.equal(resolveHostName("workstation", "linux"), "workstation");
  assert.equal(resolveHostName("localhost", "darwin", ["", "Fayon Mac\n"]), "Fayon Mac");
  assert.equal(resolveHostName("localhost", "linux"), "localhost");
  assert.equal(resolveHostName("", "darwin", []), "My computer");
});

test("parsePairLocator supports GUI-provided server and tenant", () => {
  const locator = parsePairLocator("king-ai://pair?server=https%3A%2F%2Fgui.example.com%2F&tenant=user-octo&code=abc123");
  assert.deepEqual(locator, {
    code: "abc123",
    serverUrl: "https://gui.example.com",
    tenantId: "user-octo"
  });
  assert.deepEqual(parsePairLocator("legacy-code"), { code: "legacy-code" });
});

test("missingEngineMessage gives actionable install guidance", () => {
  const message = missingEngineMessage();
  assert.match(message, /Claude Code/);
  assert.match(message, /Codex/);
  assert.match(message, /king-ai agent computer --pair <code>/);
});

test("formatDoctorReport summarizes brains, failures, and install guidance", () => {
  const report = formatDoctorReport(
    [
      { id: "claude", installed: false },
      {
        id: "codex",
        installed: true,
        path: "/usr/bin/codex",
        big: { ok: true },
        small: { ok: false, detail: "usage limit reached" }
      }
    ],
    "1.2.3"
  );

  assert.match(report, /king-ai 1\.2\.3 engine doctor/);
  assert.match(report, /big brain = main reasoning/);
  assert.match(report, /x claude - not found on PATH/);
  assert.match(report, /claude CLI is not on PATH/);
  assert.match(report, /o codex - \/usr\/bin\/codex/);
  assert.match(report, /ok big brain/);
  assert.match(report, /small brain.*FAILED: usage limit reached/);
  assert.match(report, /codex quota or billing limit is blocking runs/);
  assert.match(report, /king-ai agent computer --doctor/);
  assert.match(report, /no engine has BOTH brains healthy/);
});

test("formatDoctorReport omits unusable warning when one engine is healthy", () => {
  const report = formatDoctorReport([
    {
      id: "claude",
      installed: true,
      path: "claude",
      big: { ok: true },
      small: { ok: true }
    }
  ]);

  assert.doesNotMatch(report, /no engine has BOTH brains healthy/);
});

test("doctorExitCode fails only when no engine has both brains healthy", () => {
  assert.equal(doctorExitCode([{ id: "claude", installed: false }]), 1);
  assert.equal(doctorExitCode([{ id: "codex", installed: true, big: { ok: true }, small: { ok: false } }]), 1);
  assert.equal(doctorExitCode([{ id: "claude", installed: true, big: { ok: true }, small: { ok: true } }]), 0);
});
