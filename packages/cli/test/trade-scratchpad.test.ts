import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Scratchpad } from "../src/trade/scratchpad.js";

test("Scratchpad write/read and regime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-scratch-"));
  const path = join(dir, "scratchpad.json");
  const pad = new Scratchpad(path);
  await pad.write("test_key", { foo: "bar" }, { ttlHours: 1 });
  const data = await pad.read("test_key");
  assert.equal(data?.foo, "bar");

  await pad.setRegime("risk_on", "unit test");
  assert.equal(await pad.getRegime(), "risk_on");
  await rm(dir, { recursive: true, force: true });
});
