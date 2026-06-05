import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildProjectIntent,
  collectProjectDocs,
  detectCodeRoots,
  detectFrameworks,
  detectLanguages,
  detectPackageManagers,
  detectTests,
  formatProjectProfile,
  scanProject
} from "../src/project-profile.js";

test("scanProject detects local TypeScript repo profile signals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-profile-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "docs"), { recursive: true });
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify({
      name: "demo-app",
      description: "Demo app for takeover profiling.",
      scripts: { build: "tsc", test: "node --test dist/test/*.js" },
      dependencies: { hono: "^4.0.0" },
      devDependencies: { typescript: "^5.0.0", vitest: "^3.0.0" }
    }), "utf8");
    await writeFile(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await writeFile(join(dir, "tsconfig.json"), "{}", "utf8");
    await writeFile(join(dir, "README.md"), "# Demo App\n\nThis project has useful docs.\n", "utf8");
    await writeFile(join(dir, "docs", "ROADMAP.md"), "# Roadmap\n\n- [ ] Ship profiling\n", "utf8");

    assert.deepEqual(detectLanguages(dir), ["typescript", "javascript"]);
    assert.deepEqual(detectPackageManagers(dir), ["pnpm"]);
    assert.deepEqual(detectFrameworks(dir), ["hono"]);
    assert.deepEqual(detectTests(dir), ["vitest"]);
    assert.deepEqual(detectCodeRoots(dir), ["src"]);

    const profile = scanProject(dir);
    assert.equal(profile.hasReadme, true);
    assert.equal(profile.hasDocs, true);
    assert.equal(profile.ci[0], "github-actions");
    assert.deepEqual(profile.packageScripts, ["build", "test"]);

    const intent = buildProjectIntent(profile);
    assert.equal(intent.projectName, "demo-app");
    assert.equal(intent.roadmapDocs.length, 1);
    assert.match(intent.mission, /Continuously take over and advance demo-app/);
    assert.match(formatProjectProfile(profile, intent), /canonical docs:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("collectProjectDocs ranks root docs and manifests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "king-ai-profile-docs-"));
  try {
    await writeFile(join(dir, "README.md"), "# Read Me\n", "utf8");
    await writeFile(join(dir, "AGENTS.md"), "# Agent Rules\n", "utf8");
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: "docs-demo" }), "utf8");

    const docs = collectProjectDocs(dir);
    assert.deepEqual(docs.map((doc) => doc.path), ["README.md", "AGENTS.md", "package.json"]);
    assert.deepEqual(docs.map((doc) => doc.kind), ["readme", "notes", "manifest"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
