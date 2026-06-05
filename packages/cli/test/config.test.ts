import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("saveConfig writes loadable 0600 config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-config-"));
  process.env.KING_AI_CONFIG_DIR = dir;
  const mod = await import(`../src/config.js?case=${Date.now()}`);
  await mod.saveConfig({ serverUrl: "https://runtime.test", computerId: "c1", deviceToken: "secret", tenantId: "user-alice" });
  const loaded = await mod.loadConfig();
  assert.deepEqual(loaded, { serverUrl: "https://runtime.test", computerId: "c1", deviceToken: "secret", tenantId: "user-alice" });
  const mode = (await stat(join(dir, "computer.json"))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("resolveConfigDir uses the King AI home", async () => {
  const old = process.env.KING_AI_CONFIG_DIR;
  delete process.env.KING_AI_CONFIG_DIR;
  const mod = await import(`../src/paths.js?case=paths-${Date.now()}`);
  try {
    assert.equal(mod.commandNameFromProcess("/usr/local/bin/king-ai"), "king-ai");
    assert.equal(mod.commandNameFromProcess("/usr/local/bin/unknown"), "king-ai");
    assert.equal(mod.resolveConfigDir("king-ai").endsWith(".king-ai"), true);

    process.env.KING_AI_CONFIG_DIR = "/tmp/king-config";
    assert.equal(mod.resolveConfigDir("king-ai"), "/tmp/king-config");
  } finally {
    if (old === undefined) delete process.env.KING_AI_CONFIG_DIR;
    else process.env.KING_AI_CONFIG_DIR = old;
  }
});
