import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  deleteRemoteDevice,
  listRemoteDeviceSummaries,
  loadRemoteDevicesConfig,
  saveRemoteDevicesConfig,
  setDefaultRemoteDevice,
  upsertRemoteDevice,
} from "../src/remote-devices.js";

test("remote devices config normalizes and redacts summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-remote-devices-"));
  const path = join(root, "devices.json");
  const saved = await saveRemoteDevicesConfig(
    {
      defaultDevice: "test-61",
      devices: [
        {
          id: "test-61",
          host: "10.12.9.61",
          port: 22,
          user: "root",
          password: "secret",
          defaultApp: "fc",
          apps: { fc: { logRoots: ["/gpfc/logs"] } },
          databases: { fc: { type: "postgres", command: "psql -d gpfc" } },
          redis: { default: { command: "redis-cli" } },
        },
      ],
    },
    path,
  );
  assert.equal(saved.devices[0]?.id, "test-61");
  assert.match(await readFile(path, "utf8"), /"password": "secret"/);

  const loaded = await loadRemoteDevicesConfig(path);
  const summaries = listRemoteDeviceSummaries(loaded);
  assert.equal(summaries[0]?.auth, "password");
  assert.equal(summaries[0]?.hasPassword, true);
  assert.equal("password" in summaries[0]!, false);
});

test("remote devices config supports upsert delete and default", () => {
  const config = upsertRemoteDevice(
    { devices: [] },
    {
      id: "test-62",
      host: "10.12.9.62",
      user: "root",
      passwordEnv: "KING_AI_TEST_62_PASSWORD",
    },
  );
  assert.equal(config.defaultDevice, "test-62");
  assert.equal(config.devices.length, 1);
  assert.equal(listRemoteDeviceSummaries(config)[0]?.auth, "passwordEnv");

  const withDefault = setDefaultRemoteDevice(config, "test-62");
  assert.equal(withDefault.defaultDevice, "test-62");

  const deleted = deleteRemoteDevice(withDefault, "test-62");
  assert.equal(deleted.defaultDevice, undefined);
  assert.equal(deleted.devices.length, 0);
});
