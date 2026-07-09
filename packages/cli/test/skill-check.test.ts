import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkAllSkills,
  checkSkill,
  extractCommands,
  findSkillFiles,
  formatDashboard,
  validateCommand,
} from "../src/skill-check.js";

test("extractCommands finds king-ai command references", () => {
  const commands = extractCommands(`
    Use \`king-ai reply demo-convo hello\`.
    Then run \`king-ai task create "Fix docs"\`.
    Avoid matching king-ai CLI as a command description.
    Repeated: king-ai reply demo-convo again.
  `);
  assert.deepEqual(commands, ["reply", "task create"]);
});

test("validateCommand accepts known top-level and subcommands", () => {
  assert.equal(validateCommand("inbox"), true);
  assert.equal(validateCommand("agent computer"), true);
  assert.equal(validateCommand("capsule mine"), true);
  assert.equal(validateCommand("context delete"), true);
});

test("validateCommand rejects stale command references", () => {
  assert.equal(validateCommand("takeover"), false);
  assert.equal(validateCommand("task remove"), false);
});

test("checkSkill reports invalid references and empty command warnings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-skill-check-"));
  try {
    const skillDir = join(dir, "skill-a");
    await mkdir(skillDir);
    const skillFile = join(skillDir, "SKILL.md");
    await writeFile(skillFile, "Use `king-ai task remove old-task` after `king-ai inbox`.\n", "utf8");
    const result = checkSkill(skillFile);
    assert.equal(result.skillName, "skill-a");
    assert.deepEqual(result.referencedCommands, ["task remove", "inbox"]);
    assert.deepEqual(result.invalidCommands, ["task remove"]);

    const emptyDir = join(dir, "skill-b");
    await mkdir(emptyDir);
    const emptyFile = join(emptyDir, "SKILL.md");
    await writeFile(emptyFile, "No runtime commands here.\n", "utf8");
    const empty = checkSkill(emptyFile);
    assert.equal(empty.valid, true);
    assert.deepEqual(empty.warnings, ["No king-ai CLI commands referenced"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("findSkillFiles and checkAllSkills scan nested skill folders", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-skill-tree-"));
  try {
    await mkdir(join(dir, "outer", "inner"), { recursive: true });
    await writeFile(join(dir, "outer", "SKILL.md"), "Run `king-ai observe --json`.\n", "utf8");
    await writeFile(join(dir, "outer", "inner", "SKILL.md"), "Run `king-ai artifact put`.\n", "utf8");
    const files = findSkillFiles(dir);
    assert.equal(files.length, 2);
    const results = checkAllSkills(dir);
    assert.deepEqual(
      results.map((result) => result.skillName),
      ["outer", "inner"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatDashboard renders pass, warnings, and failures without unicode markers", () => {
  const text = formatDashboard(
    [
      {
        skillName: "valid",
        filePath: "/tmp/valid/SKILL.md",
        referencedCommands: ["reply"],
        invalidCommands: [],
        warnings: [],
        valid: true,
      },
      {
        skillName: "invalid",
        filePath: "/tmp/invalid/SKILL.md",
        referencedCommands: ["takeover"],
        invalidCommands: ["takeover"],
        warnings: ["No king-ai CLI commands referenced"],
        valid: false,
      },
    ],
    "king-ai",
  );
  assert.match(text, /king-ai skill-check/);
  assert.match(text, /\[ok\] valid/);
  assert.match(text, /\[fail\] invalid/);
  assert.match(text, /Invalid: takeover/);
  assert.match(text, /Total: 2 skills, 1 passed, 1 failed/);
});
