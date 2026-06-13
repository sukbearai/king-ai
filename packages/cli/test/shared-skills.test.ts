import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installSharedSkills, listSharedSkills, sharedSkillRoots, sharedSkillSnapshotsRoot } from "../src/shared-skills.js";

test("sharedSkillRoots reads KING skill roots", () => {
  assert.deepEqual(sharedSkillRoots({ KING_AI_SHARED_SKILLS: `/a${delimiter}/b,/c` } as NodeJS.ProcessEnv), ["/a", "/b", "/c"]);
  assert.deepEqual(sharedSkillRoots({} as NodeJS.ProcessEnv), []);
});

test("sharedSkillSnapshotsRoot reads KING snapshot roots", () => {
  assert.equal(sharedSkillSnapshotsRoot({ KING_AI_SKILL_SNAPSHOTS_DIR: "/snapshots" } as NodeJS.ProcessEnv), "/snapshots");
  assert.equal(sharedSkillSnapshotsRoot({} as NodeJS.ProcessEnv), undefined);
});

test("listSharedSkills finds directories containing SKILL.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-shared-skills-"));
  try {
    await mkdir(join(root, "research"), { recursive: true });
    await mkdir(join(root, "ignored"), { recursive: true });
    await writeFile(join(root, "research", "SKILL.md"), "# Research\n", "utf8");
    await writeFile(join(root, "ignored", "README.md"), "no skill\n", "utf8");

    const skills = await listSharedSkills([root]);
    assert.deepEqual(skills.map((skill) => skill.name), ["research"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installSharedSkills copies shared skills into Claude and Codex homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "king-ai-shared-skills-"));
  const home = await mkdtemp(join(tmpdir(), "king-ai-ceo-home-"));
  const snapshotsRoot = await mkdtemp(join(tmpdir(), "king-ai-skill-snapshots-"));
  try {
    await mkdir(join(root, "takeover-context"), { recursive: true });
    await writeFile(join(root, "takeover-context", "SKILL.md"), "# Takeover\n", "utf8");
    await writeFile(join(root, "takeover-context", "notes.md"), "extra\n", "utf8");

    const result = await installSharedSkills(home, [root], { KING_AI_SKILL_SNAPSHOTS_DIR: snapshotsRoot } as NodeJS.ProcessEnv);

    assert.deepEqual(result.installed.map((skill) => skill.name), ["takeover-context"]);
    assert.ok(result.snapshot);
    assert.match(result.snapshot.id, /^skills-/);
    assert.equal(result.snapshot.root.startsWith(snapshotsRoot), true);
    assert.equal(result.snapshot.skills[0].name, "takeover-context");
    const manifest = JSON.parse(await readFile(result.snapshot.manifestPath, "utf8")) as { skills: Array<{ name: string }> };
    assert.deepEqual(manifest.skills.map((skill) => skill.name), ["takeover-context"]);
    assert.equal(await readFile(join(result.snapshot.root, "takeover-context", "SKILL.md"), "utf8"), "# Takeover\n");
    assert.equal(await readFile(join(home, ".claude", "skills", "takeover-context", "SKILL.md"), "utf8"), "# Takeover\n");
    assert.equal(await readFile(join(home, ".codex", "skills", "takeover-context", "notes.md"), "utf8"), "extra\n");
    assert.equal(await readFile(join(home, ".grok", "skills", "takeover-context", "SKILL.md"), "utf8"), "# Takeover\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(snapshotsRoot, { recursive: true, force: true });
  }
});

test("learned skills install alongside shared skills, with shared roots winning on name collision", async () => {
  const shared = await mkdtemp(join(tmpdir(), "king-ai-shared-"));
  const learned = await mkdtemp(join(tmpdir(), "king-ai-learned-"));
  try {
    await mkdir(join(shared, "deploy"), { recursive: true });
    await writeFile(join(shared, "deploy", "SKILL.md"), "# Shared deploy\n", "utf8");
    await mkdir(join(learned, "deploy"), { recursive: true });
    await writeFile(join(learned, "deploy", "SKILL.md"), "# Learned deploy\n", "utf8");
    await mkdir(join(learned, "recall-tips"), { recursive: true });
    await writeFile(join(learned, "recall-tips", "SKILL.md"), "# Recall tips\n", "utf8");

    // The runner installs from [...sharedSkillRoots(), learnedSkillsDir(id)] — shared first.
    const skills = await listSharedSkills([shared, learned]);
    assert.deepEqual(skills.map((skill) => skill.name).sort(), ["deploy", "recall-tips"]);
    assert.equal(skills.find((skill) => skill.name === "deploy")?.sourceDir, join(shared, "deploy"));
  } finally {
    await rm(shared, { recursive: true, force: true });
    await rm(learned, { recursive: true, force: true });
  }
});
