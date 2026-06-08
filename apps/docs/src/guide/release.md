# Deploy & Release

Release tags drive publishing for this repository.

## Local Checks

Run verification before preparing a release:

```sh
pnpm verify
```

The root build includes the CLI package, GUI worker, and documentation site.

## Version Bump

Use one of the release scripts:

```sh
pnpm release:patch
pnpm release:minor
pnpm release:major
```

The script verifies the workspace, bumps versions, commits `Release v%s`, tags `v%s`, and pushes the commit and tag.

## GitHub Actions Workflow

The release workflow lives at `.github/workflows/publish.yml` and runs only when a pushed tag matches `v*`.

The job runs these steps:

1. Check out the repository.
2. Install pnpm and Node.js 22.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Read `packages/cli/package.json`.
5. Verify the pushed tag exactly matches the package version, for example tag `v0.2.24` for version `0.2.24`.
6. Run `pnpm verify`.
7. Copy the root README into the CLI package metadata.
8. Publish `@suwujs/king-ai` to npm with provenance, unless the exact version is already published.
9. Validate Cloudflare and auth deployment secrets.
10. Sync Worker secrets into Cloudflare.
11. Deploy the GUI Worker with `pnpm --filter @king-ai/gui-worker run deploy`.

## Required GitHub Secrets

The workflow needs these repository secrets:

- `NPM_TOKEN`: npm automation token for publishing `@suwujs/king-ai`.
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: Cloudflare API token with Worker deploy and secret-write access.
- `BETTER_AUTH_SECRET`: Better Auth secret for the deployed GUI.
- `BETTER_AUTH_URL`: public auth URL for the deployed GUI.
- `AUTH_GITHUB_CLIENT_ID`: GitHub OAuth client ID.
- `AUTH_GITHUB_CLIENT_SECRET`: GitHub OAuth client secret.

GitHub Actions secrets cannot use the `GITHUB_` prefix for custom secret names. Store OAuth credentials as `AUTH_GITHUB_CLIENT_ID` and `AUTH_GITHUB_CLIENT_SECRET`; the workflow maps them back to Worker secrets named `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

## Publishing And Deployment Boundaries

GitHub Actions handles npm publish and Cloudflare Worker deployment from the pushed release tag. Do not run local npm publish or direct Worker deployment as part of a normal release.

The repository still has local Worker commands such as `pnpm gui:deploy` for targeted maintenance, but production releases should use the tag-driven workflow so package publishing, secret sync, and Worker deploy stay tied to the same verified version.
