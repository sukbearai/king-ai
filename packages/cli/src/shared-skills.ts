import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, delimiter, join } from "node:path";

export interface SharedSkill {
  name: string;
  sourceDir: string;
}

export interface SharedSkillInstallResult {
  sourceRoots: string[];
  installed: SharedSkill[];
  targets: string[];
  snapshot?: SharedSkillSnapshot;
}

export interface SharedSkillSnapshot {
  id: string;
  createdAt: string;
  root: string;
  manifestPath: string;
  skills: SharedSkillSnapshotSkill[];
}

export interface SharedSkillSnapshotSkill {
  name: string;
  sourceDir: string;
  snapshotDir: string;
}

function splitRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry, idx, all) => all.indexOf(entry) === idx);
}

export function sharedSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return splitRoots(env.KING_SHARED_SKILLS);
}

export function sharedSkillSnapshotsRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.KING_SKILL_SNAPSHOTS_DIR;
}

export async function listSharedSkills(sourceRoots: string[]): Promise<SharedSkill[]> {
  const skills: SharedSkill[] = [];
  const seen = new Set<string>();
  for (const root of sourceRoots) {
    if (!existsSync(root)) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDir = join(root, entry.name);
      if (!existsSync(join(sourceDir, "SKILL.md"))) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      skills.push({ name: entry.name, sourceDir });
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function installSharedSkills(
  agentHome: string,
  sourceRoots = sharedSkillRoots(),
  env: NodeJS.ProcessEnv = process.env
): Promise<SharedSkillInstallResult> {
  const skills = await listSharedSkills(sourceRoots);
  const targets = [join(agentHome, ".claude", "skills"), join(agentHome, ".codex", "skills")];
  const snapshot = await createSharedSkillSnapshot(agentHome, skills, env);
  for (const target of targets) await mkdir(target, { recursive: true });
  for (const skill of skills) {
    const sourceStat = await stat(skill.sourceDir);
    if (!sourceStat.isDirectory()) continue;
    for (const target of targets) {
      const dest = join(target, skill.name || basename(skill.sourceDir));
      await rm(dest, { recursive: true, force: true });
      const snapshotSkill = snapshot?.skills.find((entry) => entry.name === skill.name);
      await cp(snapshotSkill?.snapshotDir ?? skill.sourceDir, dest, { recursive: true });
    }
  }
  return { sourceRoots, installed: skills, targets, snapshot };
}

async function createSharedSkillSnapshot(agentHome: string, skills: SharedSkill[], env: NodeJS.ProcessEnv = process.env): Promise<SharedSkillSnapshot | undefined> {
  if (skills.length === 0) return undefined;
  const snapshotId = `skills-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const root = join(sharedSkillSnapshotsRoot(env) || join(agentHome, ".king", "skill-snapshots"), snapshotId);
  await mkdir(root, { recursive: true });

  const snapshotSkills: SharedSkillSnapshotSkill[] = [];
  for (const skill of skills) {
    const snapshotDir = join(root, skill.name || basename(skill.sourceDir));
    await cp(skill.sourceDir, snapshotDir, { recursive: true });
    snapshotSkills.push({
      name: skill.name,
      sourceDir: skill.sourceDir,
      snapshotDir
    });
  }

  const snapshot: SharedSkillSnapshot = {
    id: snapshotId,
    createdAt: new Date().toISOString(),
    root,
    manifestPath: join(root, "manifest.json"),
    skills: snapshotSkills
  };
  await writeFile(snapshot.manifestPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}
