import { spawnSync } from "node:child_process";

const release = process.argv[2];
const extraArgs = process.argv.slice(3);
const allowedReleases = new Set([
  undefined,
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
]);
const publishArgSet = new Set(extraArgs);
const skipPush = publishArgSet.has("--skip-push");
const publishArgs = extraArgs.filter((arg) => arg !== "--" && arg !== "--skip-publish" && arg !== "--skip-push");

if (!allowedReleases.has(release)) {
  console.error(`Unsupported release type: ${release}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
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
  "--no-push",
];

if (release) {
  args.push("--release", release, "--yes");
}

args.push(...publishArgs);

runOrExit("pnpm", args);

if (!skipPush) {
  runOrExit("git", ["push", "--follow-tags"]);
}
