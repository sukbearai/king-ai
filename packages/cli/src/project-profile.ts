import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export type ProjectDocumentKind = "readme" | "roadmap" | "docs" | "manifest" | "notes";

export interface ProjectDocument {
  path: string;
  kind: ProjectDocumentKind;
  title: string;
  excerpt: string;
  headings: string[];
  score: number;
}

export interface ProjectProfile {
  path: string;
  languages: string[];
  packageManagers: string[];
  frameworks: string[];
  ci: string[];
  testFrameworks: string[];
  hasReadme: boolean;
  hasAgentsMd: boolean;
  hasDocs: boolean;
  issueTracker: "github" | "none";
  githubRemote?: string;
  readmeExcerpt?: string;
  codeRoots: string[];
  packageScripts: string[];
}

export interface ProjectIntent {
  projectName: string;
  summary: string;
  canonicalDocs: ProjectDocument[];
  roadmapDocs: ProjectDocument[];
  codeRoots: string[];
  packageScripts: string[];
  strategicThemes: string[];
  mission: string;
}

function hasFile(projectPath: string, name: string): boolean {
  return existsSync(join(projectPath, name));
}

function readPackageJson(projectPath: string): Record<string, unknown> | null {
  const file = join(projectPath, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function packageDeps(projectPath: string): Record<string, unknown> {
  const pkg = readPackageJson(projectPath);
  const deps = typeof pkg?.dependencies === "object" && pkg.dependencies ? pkg.dependencies : {};
  const devDeps = typeof pkg?.devDependencies === "object" && pkg.devDependencies ? pkg.devDependencies : {};
  return { ...deps, ...devDeps };
}

export function detectLanguages(projectPath: string): string[] {
  const languages: string[] = [];
  if (hasFile(projectPath, "package.json")) {
    if (
      hasFile(projectPath, "tsconfig.json") ||
      hasFile(projectPath, "tsconfig.base.json") ||
      hasFile(projectPath, "tsconfig.build.json")
    )
      languages.push("typescript");
    languages.push("javascript");
  }
  if (hasFile(projectPath, "Cargo.toml")) languages.push("rust");
  if (hasFile(projectPath, "go.mod")) languages.push("go");
  if (
    hasFile(projectPath, "requirements.txt") ||
    hasFile(projectPath, "pyproject.toml") ||
    hasFile(projectPath, "setup.py")
  )
    languages.push("python");
  if (hasFile(projectPath, "Gemfile")) languages.push("ruby");
  if (hasFile(projectPath, "pom.xml") || hasFile(projectPath, "build.gradle")) languages.push("java");
  if (hasFile(projectPath, "Package.swift")) languages.push("swift");
  if (hasFile(projectPath, "pubspec.yaml")) languages.push("dart");
  return languages;
}

export function detectPackageManagers(projectPath: string): string[] {
  const managers: string[] = [];
  if (hasFile(projectPath, "pnpm-lock.yaml") || hasFile(projectPath, "pnpm-workspace.yaml")) managers.push("pnpm");
  else if (hasFile(projectPath, "yarn.lock")) managers.push("yarn");
  else if (hasFile(projectPath, "package-lock.json")) managers.push("npm");
  if (hasFile(projectPath, "Cargo.lock")) managers.push("cargo");
  if (hasFile(projectPath, "go.sum")) managers.push("go");
  if (hasFile(projectPath, "Pipfile.lock") || hasFile(projectPath, "poetry.lock")) managers.push("pip");
  return managers;
}

export function detectFrameworks(projectPath: string): string[] {
  const deps = packageDeps(projectPath);
  const frameworks: string[] = [];
  if ("next" in deps) frameworks.push("nextjs");
  if ("react" in deps) frameworks.push("react");
  if ("vue" in deps) frameworks.push("vue");
  if ("svelte" in deps || "@sveltejs/kit" in deps) frameworks.push("svelte");
  if ("express" in deps) frameworks.push("express");
  if ("fastify" in deps) frameworks.push("fastify");
  if ("hono" in deps) frameworks.push("hono");
  if ("expo" in deps) frameworks.push("expo");
  if ("vite" in deps) frameworks.push("vite");
  return frameworks;
}

export function detectCI(projectPath: string): string[] {
  const ci: string[] = [];
  const workflows = join(projectPath, ".github", "workflows");
  if (existsSync(workflows) && statSync(workflows).isDirectory()) ci.push("github-actions");
  if (hasFile(projectPath, ".gitlab-ci.yml")) ci.push("gitlab-ci");
  if (hasFile(projectPath, ".circleci/config.yml")) ci.push("circleci");
  if (hasFile(projectPath, "Jenkinsfile")) ci.push("jenkins");
  if (hasFile(projectPath, "Dockerfile") || hasFile(projectPath, "docker-compose.yml")) ci.push("docker");
  if (hasFile(projectPath, "vercel.json") || hasFile(projectPath, ".vercel")) ci.push("vercel");
  if (hasFile(projectPath, "wrangler.toml")) ci.push("cloudflare");
  return ci;
}

export function detectTests(projectPath: string): string[] {
  const deps = packageDeps(projectPath);
  const tests: string[] = [];
  if ("vitest" in deps) tests.push("vitest");
  if ("jest" in deps) tests.push("jest");
  if ("mocha" in deps) tests.push("mocha");
  if ("playwright" in deps || "@playwright/test" in deps) tests.push("playwright");
  if ("cypress" in deps) tests.push("cypress");
  if (hasFile(projectPath, "pytest.ini") || hasFile(projectPath, "conftest.py")) tests.push("pytest");
  if (hasFile(projectPath, "test") || hasFile(projectPath, "tests")) tests.push("node-test");
  return Array.from(new Set(tests));
}

export function detectGitHubRemote(projectPath: string): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: projectPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (remote.includes("github.com")) return remote;
  } catch {
    return undefined;
  }
  return undefined;
}

export function scanReadme(projectPath: string): string | undefined {
  for (const name of ["README.md", "readme.md", "README.rst", "README"]) {
    const file = join(projectPath, name);
    if (existsSync(file) && statSync(file).isFile()) return readTextSnippet(file, 500);
  }
  return undefined;
}

export function detectCodeRoots(projectPath: string): string[] {
  const roots = [
    "src",
    "app",
    "apps",
    "packages",
    "services",
    "backend",
    "frontend",
    "web",
    "api",
    "lib",
    "cmd",
    "gui-worker",
  ];
  return roots.filter((name) => {
    const dir = join(projectPath, name);
    return existsSync(dir) && statSync(dir).isDirectory();
  });
}

export function detectPackageScripts(projectPath: string): string[] {
  const pkg = readPackageJson(projectPath);
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts !== "object") return [];
  return Object.keys(scripts);
}

function readTextSnippet(filePath: string, maxChars = 1600): string {
  try {
    return readFileSync(filePath, "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function extractHeadings(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(#{1,3}\s+|[-*]\s+\[[ xX]\]\s+)/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, "").trim())
    .slice(0, 8);
}

function titleFromContent(filePath: string, content: string): string {
  const heading = content
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));
  return heading ? heading.replace(/^#\s+/, "").trim() : basename(filePath);
}

function scoreDocument(relativePath: string): { score: number; kind: ProjectDocumentKind } {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (/^readme(\.|$)/.test(normalized)) return { score: 100, kind: "readme" };
  if (/(^|\/)(roadmap|todo|backlog|milestone|plan|vision|prd|strategy)/.test(normalized))
    return { score: 95, kind: "roadmap" };
  if (/^agents\.md$|^claude\.md$/.test(normalized)) return { score: 85, kind: "notes" };
  if (/^package\.json$|^pyproject\.toml$|^cargo\.toml$|^go\.mod$/.test(normalized))
    return { score: 70, kind: "manifest" };
  if (/^docs\/.+\.(md|mdx|rst|txt)$/.test(normalized)) return { score: 60, kind: "docs" };
  if (/\.(md|mdx|rst|txt)$/.test(normalized)) return { score: 40, kind: "notes" };
  return { score: 0, kind: "notes" };
}

function walkDocsDir(root: string, dir: string, acc: string[], depth = 0): void {
  if (depth > 3) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDocsDir(root, fullPath, acc, depth + 1);
      continue;
    }
    const rel = relative(root, fullPath);
    if (/\.(md|mdx|rst|txt|json|toml|ya?ml)$/i.test(rel)) acc.push(fullPath);
  }
}

export function collectProjectDocs(projectPath: string): ProjectDocument[] {
  const candidates = new Map<string, string>();
  const addCandidate = (file: string) => {
    const key = relative(projectPath, file).replace(/\\/g, "/").toLowerCase();
    if (!candidates.has(key)) candidates.set(key, file);
  };
  for (const name of [
    "README.md",
    "readme.md",
    "README.rst",
    "README",
    "AGENTS.md",
    "CLAUDE.md",
    "ROADMAP.md",
    "ROADMAP",
    "TODO.md",
    "TODO",
    "CHANGELOG.md",
    "PLAN.md",
    "VISION.md",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
  ]) {
    const file = join(projectPath, name);
    if (existsSync(file) && statSync(file).isFile()) addCandidate(file);
  }
  const docsDir = join(projectPath, "docs");
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    const docs: string[] = [];
    walkDocsDir(projectPath, docsDir, docs);
    for (const file of docs) addCandidate(file);
  }

  return Array.from(candidates.values())
    .map((filePath) => {
      const rel = relative(projectPath, filePath).replace(/\\/g, "/");
      const { score, kind } = scoreDocument(rel);
      const excerpt = readTextSnippet(filePath);
      return {
        path: rel,
        kind,
        title: titleFromContent(filePath, excerpt),
        excerpt,
        headings: extractHeadings(excerpt),
        score,
      } satisfies ProjectDocument;
    })
    .filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 10);
}

export function scanProject(projectPath: string): ProjectProfile {
  const absPath = resolve(projectPath);
  const githubRemote = detectGitHubRemote(absPath);
  const docsDir = join(absPath, "docs");
  return {
    path: absPath,
    languages: detectLanguages(absPath),
    packageManagers: detectPackageManagers(absPath),
    frameworks: detectFrameworks(absPath),
    ci: detectCI(absPath),
    testFrameworks: detectTests(absPath),
    hasReadme: hasFile(absPath, "README.md") || hasFile(absPath, "readme.md"),
    hasAgentsMd: hasFile(absPath, "AGENTS.md"),
    hasDocs: existsSync(docsDir) && statSync(docsDir).isDirectory(),
    issueTracker: githubRemote ? "github" : "none",
    githubRemote,
    readmeExcerpt: scanReadme(absPath),
    codeRoots: detectCodeRoots(absPath),
    packageScripts: detectPackageScripts(absPath),
  };
}

function inferProjectName(profile: ProjectProfile, docs: ProjectDocument[]): string {
  const pkg = readPackageJson(profile.path);
  const name = typeof pkg?.name === "string" ? pkg.name.trim() : "";
  if (name) return name;
  const readme = docs.find((doc) => doc.kind === "readme");
  return readme?.title || basename(profile.path);
}

function inferProjectSummary(profile: ProjectProfile, docs: ProjectDocument[]): string {
  const pkg = readPackageJson(profile.path);
  const description = typeof pkg?.description === "string" ? pkg.description.trim() : "";
  if (description) return description;
  const readme = docs.find((doc) => doc.kind === "readme");
  if (readme?.excerpt) {
    const summary = readme.excerpt.replace(/\s+/g, " ").replace(/^#.+$/, "").trim().slice(0, 220);
    if (summary) return summary;
  }
  const stack = [profile.frameworks[0], profile.languages[0]].filter(Boolean).join(" / ");
  return stack
    ? `${inferProjectName(profile, docs)} - ${stack} project`
    : `Maintain and advance ${inferProjectName(profile, docs)}`;
}

function buildStrategicThemes(profile: ProjectProfile, docs: ProjectDocument[]): string[] {
  const themes = new Set<string>();
  const roadmapDocs = docs.filter((doc) => doc.kind === "roadmap");
  if (roadmapDocs.length > 0) themes.add("Advance incomplete roadmap, plan, and backlog items closest to user value");
  if (profile.hasReadme || profile.hasDocs)
    themes.add("Keep README, docs, and changelog consistent with implementation");
  if (profile.ci.length > 0 || profile.testFrameworks.length > 0)
    themes.add("Keep tests, CI, build, and release pipelines operational");
  if (profile.codeRoots.length > 0)
    themes.add(`Review core code directories ${profile.codeRoots.join(", ")} for structural issues`);
  themes.add(
    profile.issueTracker === "github"
      ? "Convert external issues and feedback into scoped local tasks"
      : "Mine backlog from code, docs, TODOs, and scripts when external issues are unavailable",
  );
  return Array.from(themes);
}

export function buildProjectIntent(profile: ProjectProfile): ProjectIntent {
  const docs = collectProjectDocs(profile.path);
  const projectName = inferProjectName(profile, docs);
  const summary = inferProjectSummary(profile, docs);
  const strategicThemes = buildStrategicThemes(profile, docs);
  const stack = [profile.frameworks[0], profile.languages[0]].filter(Boolean).join(" / ");
  return {
    projectName,
    summary,
    canonicalDocs: docs,
    roadmapDocs: docs.filter((doc) => doc.kind === "roadmap"),
    codeRoots: profile.codeRoots,
    packageScripts: profile.packageScripts,
    strategicThemes,
    mission: [
      `Continuously take over and advance ${projectName}${stack ? ` (${stack})` : ""}.`,
      `Project summary: ${summary}`,
      `Operating principles: ${strategicThemes.join("; ")}`,
    ].join(" "),
  };
}

export function formatProjectProfile(profile: ProjectProfile, intent = buildProjectIntent(profile)): string {
  const lines = [
    `Project profile: ${intent.projectName}`,
    `path: ${profile.path}`,
    `summary: ${intent.summary}`,
    `languages: ${profile.languages.join(", ") || "none"}`,
    `package managers: ${profile.packageManagers.join(", ") || "none"}`,
    `frameworks: ${profile.frameworks.join(", ") || "none"}`,
    `tests: ${profile.testFrameworks.join(", ") || "none"}`,
    `ci: ${profile.ci.join(", ") || "none"}`,
    `code roots: ${profile.codeRoots.join(", ") || "repo root"}`,
    `package scripts: ${profile.packageScripts.join(", ") || "none"}`,
    `issue tracker: ${profile.issueTracker}${profile.githubRemote ? ` (${profile.githubRemote})` : ""}`,
    "canonical docs:",
    ...(intent.canonicalDocs.length
      ? intent.canonicalDocs.map((doc) => `  - ${doc.path} [${doc.kind}] ${doc.title}`)
      : ["  - none"]),
    "strategic themes:",
    ...intent.strategicThemes.map((theme) => `  - ${theme}`),
    `mission: ${intent.mission}`,
  ];
  return lines.join("\n");
}

export function runProjectProfile(projectPath: string): void {
  const profile = scanProject(projectPath);
  console.log(formatProjectProfile(profile));
}
