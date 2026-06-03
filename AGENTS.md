# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm workspace for a local agent daemon. The publishable CLI package lives in `packages/cli/`; `packages/cli/src/cli.ts` defines the `king` command, `packages/cli/src/daemon.ts` coordinates pairing and runner startup, `packages/cli/src/runner.ts` handles per-agent runtime loops, and `packages/cli/src/engine.ts` adapts local `claude` and `codex` CLIs. Shared runtime types are in `packages/cli/src/types.ts`.

CLI tests live in `packages/cli/test/` and compile into `packages/cli/dist/test/`. The optional Cloudflare GUI runtime app is under `apps/gui-worker/`, with tests in `apps/gui-worker/test/`. Generated output belongs in package-local `dist/` directories and should not be edited by hand.

## Build, Test, and Development Commands

- `pnpm install`: install package dependencies from `pnpm-lock.yaml`.
- `pnpm build`: build the CLI package and GUI worker app.
- `pnpm test`: run compiled Node tests for the workspace packages; build first.
- `pnpm verify`: build and run the full test suite.
- `pnpm dev -- agent computer --doctor`: run the CLI package through `tsx` during development.
- `pnpm gui:dev`: start the GUI Cloudflare Worker with Wrangler.

Use `pnpm verify` before handing off code changes.

## Coding Style & Naming Conventions

Use TypeScript ES modules with explicit `.js` extensions in relative imports, matching the existing files. Keep two-space indentation, concise functions, and clear named exports. Prefer small modules with direct responsibilities over broad utility files. Use `camelCase` for variables/functions, `PascalCase` for classes and exported interfaces, and uppercase constants for environment-derived timing/config values.

No formatter or linter is currently configured, so preserve the existing style manually.

## Testing Guidelines

Tests use Node's built-in test runner (`node --test`) and should be placed in `test/*.test.ts`. Keep tests focused on behavior that can run without real Claude/Codex credentials or a live runtime server. When adding daemon or runner logic, prefer unit tests around parsing, configuration, engine selection, and request shaping.

Run `pnpm build && pnpm test` or `pnpm verify` after changes.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes such as `feat:` and `fix:`; continue that pattern with short, specific English summaries. Commit messages in this repository must be written in English. PRs should describe the behavior change, list verification commands run, and call out any runtime-server API assumptions. Include logs or terminal output when changing service installation, pairing, SSE, or engine invocation behavior.

## Security & Configuration Tips

This daemon bridges remote runtime events to local CLI processes and is not an OS sandbox. Treat `serverUrl`, `deviceToken`, runtime tokens, and per-agent homes under `~/.king/` as sensitive. Do not log full tokens or persist secrets outside the existing config/token paths.
