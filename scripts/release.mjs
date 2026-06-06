import { spawnSync } from "node:child_process";

const release = process.argv[2];
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

if (!allowedReleases.has(release)) {
  console.error(`Unsupported release type: ${release}`);
  process.exit(1);
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
  "--push"
];

if (release) {
  args.push("--release", release, "--yes");
}

args.push(...process.argv.slice(3));

const result = spawnSync("pnpm", args, {
  stdio: "inherit",
  shell: false
});

process.exit(result.status ?? 1);
