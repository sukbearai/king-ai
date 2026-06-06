import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";

const release = process.argv[2];
const extraArgs = process.argv.slice(3);
const packageReadmePath = "packages/cli/README.md";
const allowedReleases = new Set([
  undefined,
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease"
]);
const publishArgSet = new Set(extraArgs);
const skipPublish = publishArgSet.has("--skip-publish");
const skipPush = publishArgSet.has("--skip-push");
const publishArgs = extraArgs.filter((arg) => arg !== "--skip-publish" && arg !== "--skip-push");

if (!allowedReleases.has(release)) {
  console.error(`Unsupported release type: ${release}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });

  return result.status ?? 1;
}

function runOrExit(command, args) {
  const status = run(command, args);
  if (status !== 0) process.exit(status);
}

const args = [
  "exec",
  "bumpp",
  "--recursive",
  "--all",
  "--git-check",
  "--execute",
  "node scripts/release-check.mjs",
  "--commit",
  "Release v%s",
  "--tag",
  "v%s",
  "--no-push"
];

if (release) {
  args.push("--release", release, "--yes");
}

args.push(...publishArgs);

runOrExit("pnpm", args);

if (!skipPublish) {
  let publishStatus = 0;
  try {
    copyFileSync("README.md", packageReadmePath);
    publishStatus = run("npm", ["publish", "--access", "public", "./packages/cli"]);
  } finally {
    if (existsSync(packageReadmePath)) {
      rmSync(packageReadmePath);
    }
  }
  if (publishStatus !== 0) process.exit(publishStatus);
}

if (!skipPush) {
  runOrExit("git", ["push", "--follow-tags"]);
}
