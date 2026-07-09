import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { linkHostHomeEntries, resolveHostHomeEntry, resolveHostHomeEntryNames } from "../src/host-home.js";

test("resolveHostHomeEntryNames reads KING entries", () => {
  assert.deepEqual(resolveHostHomeEntryNames({} as NodeJS.ProcessEnv), []);
  assert.deepEqual(
    resolveHostHomeEntryNames({ KING_AI_HOST_HOME_ENTRIES: `.gitconfig${delimiter}.npmrc,.ssh` } as NodeJS.ProcessEnv),
    [".gitconfig", ".npmrc", ".ssh"],
  );
});

test("resolveHostHomeEntry accepts only single host-home dot entries", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-host-home-"));
  try {
    assert.deepEqual(resolveHostHomeEntry(".gitconfig", home), {
      name: ".gitconfig",
      source: join(home, ".gitconfig"),
    });
    assert.deepEqual(resolveHostHomeEntry("~/.gitconfig", home), {
      name: ".gitconfig",
      source: join(home, ".gitconfig"),
    });
    assert.equal(resolveHostHomeEntry("notes.txt", home), null);
    assert.equal(resolveHostHomeEntry("../.ssh", home), null);
    assert.equal(resolveHostHomeEntry(".config/npm", home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("linkHostHomeEntries symlinks explicit existing entries and records skips", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-host-home-"));
  const agentHome = await mkdtemp(join(tmpdir(), "king-ai-ceo-home-"));
  try {
    await writeFile(join(home, ".gitconfig"), "[user]\n", "utf8");
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh", "config"), "Host *\n", "utf8");

    const entries = await linkHostHomeEntries(
      agentHome,
      {
        KING_AI_HOST_HOME_ENTRIES: `.gitconfig,.ssh,.missing,notes.txt`,
      } as NodeJS.ProcessEnv,
      home,
    );

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.linked]),
      [
        [".gitconfig", true],
        [".ssh", true],
        [".missing", false],
        ["notes.txt", false],
      ],
    );
    assert.equal((await lstat(join(agentHome, ".gitconfig"))).isSymbolicLink(), true);
    assert.equal((await lstat(join(agentHome, ".ssh"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(agentHome, ".gitconfig"), "utf8"), "[user]\n");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentHome, { recursive: true, force: true });
  }
});

test("linkHostHomeEntries does not link host credentials by default", async () => {
  const home = await mkdtemp(join(tmpdir(), "king-ai-host-home-"));
  const agentHome = await mkdtemp(join(tmpdir(), "king-ai-ceo-home-"));
  try {
    await writeFile(join(home, ".gitconfig"), "[user]\n", "utf8");
    await mkdir(join(home, ".ssh"));

    const entries = await linkHostHomeEntries(agentHome, {} as NodeJS.ProcessEnv, home);

    assert.deepEqual(entries, []);
    await assert.rejects(() => lstat(join(agentHome, ".gitconfig")));
    await assert.rejects(() => lstat(join(agentHome, ".ssh")));
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(agentHome, { recursive: true, force: true });
  }
});
