import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("saveConfig writes loadable 0600 config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-config-"));
  process.env.KING_CONFIG_DIR = dir;
  const mod = await import(`../src/config.js?case=${Date.now()}`);
  await mod.saveConfig({ serverUrl: "https://runtime.test", computerId: "c1", deviceToken: "secret" });
  const loaded = await mod.loadConfig();
  assert.deepEqual(loaded, { serverUrl: "https://runtime.test", computerId: "c1", deviceToken: "secret" });
  const mode = (await stat(join(dir, "computer.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("resolveConfigDir uses the King home", async () => {
  const old = process.env.KING_CONFIG_DIR;
  delete process.env.KING_CONFIG_DIR;
  const mod = await import(`../src/paths.js?case=paths-${Date.now()}`);
  try {
    assert.equal(mod.commandNameFromProcess("/usr/local/bin/king"), "king");
    assert.equal(mod.resolveConfigDir("king").endsWith(".king"), true);

    process.env.KING_CONFIG_DIR = "/tmp/king-config";
    assert.equal(mod.resolveConfigDir("king"), "/tmp/king-config");
  } finally {
    if (old === undefined) delete process.env.KING_CONFIG_DIR;
    else process.env.KING_CONFIG_DIR = old;
  }
});
