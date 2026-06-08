# Repository Guidelines

## Project Structure & Module Organization

This is the `sukbearai/king-ai` pnpm workspace for a local BYOA multi-agent collaboration system. The publishable CLI package lives in `packages/cli/`; `packages/cli/src/cli.ts` defines the `king-ai` command, `packages/cli/src/daemon.ts` coordinates pairing and runner startup, `packages/cli/src/runner.ts` handles per-agent runtime loops, and `packages/cli/src/engine.ts` adapts local `claude` and `codex` CLIs. Shared runtime types are in `packages/cli/src/types.ts`.

Multi-role collaboration logic is part of the core product. `packages/cli/src/team-workflow.ts` defines role templates, team specs, permissions, and built-in workflow scenarios; `packages/cli/src/team-routing.ts` handles capability-first owner selection, reviews, handoffs, and human-decision routing; `packages/cli/src/host-control.ts` applies host command governance and workflow materialization. When changing agent/runtime behavior, preserve the distinction between the local execution boundary and the collaboration governance layer.

CLI tests live in `packages/cli/test/` and compile into `packages/cli/dist/test/`. The optional Cloudflare GUI runtime app is under `apps/gui-worker/`, with tests in `apps/gui-worker/test/`. Generated output belongs in package-local `dist/` directories and should not be edited by hand.

The GUI worker is split by runtime boundary. `apps/gui-worker/src/index.ts` is a small barrel that re-exports the Durable Object and test-facing helpers from `gui-state-do.ts`. `gui-state-do.ts` owns the `GuiState` Durable Object implementation. `gui-types.ts` owns shared GUI runtime types and constants; keep request auth HTML out of this file. `gui-auth.ts` owns Better Auth, tenant resolution, request context auth, and login HTML. `gui-http.ts` owns small HTTP/stream helpers. `gui-routes.ts` creates the Hono app and should receive its dependencies through `createGuiApp`. Workflow card/task ledger writes should go through `workflow-state.ts`, artifact validation/parsing through `artifact-helpers.ts`, runtime CLI dispatch through `runtime-cli-dispatch.ts`, and command-specific behavior through the `gui-cli-*.ts` modules. The GUI page shell is `page.tsx`; browser scripts and styles live in the `gui-client-*` and `gui-page-*` modules.

## Runtime Architecture Principles

Preserve LLM autonomy when hardening the runtime. The model should decide strategy and content: whether to answer, delegate, ask the human, create or update a task, request review, or intentionally stay silent with a reason. Code should not force agents through a rigid, form-like workflow unless a product requirement explicitly calls for it.

Use code-level constraints for the system ledger instead. Runtime changes should make identity, conversation boundaries, task ownership, idempotency, token lifetime, audit records, and recovery semantics explicit and verifiable. In short: LLMs own thinking and collaboration strategy; the system owns boundaries, state transitions, and durable accounting.

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

Tests use Node's built-in test runner (`node --test`) and should be placed in `test/*.test.ts`. Keep tests focused on behavior that can run without real Claude/Codex credentials or a live runtime server. When adding daemon or runner logic, prefer unit tests around parsing, configuration, engine selection, and request shaping. When changing team roles, workflow scenarios, routing, permissions, reviews, handoffs, claims, or human-decision gates, add focused tests around the pure workflow/router/governance functions.

Run `pnpm build && pnpm test` or `pnpm verify` after changes.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit prefixes such as `feat:` and `fix:`; continue that pattern with short, specific English summaries. Commit messages in this repository must be written in English. PRs should describe the behavior change, list verification commands run, and call out any runtime-server API assumptions. Include logs or terminal output when changing service installation, pairing, SSE, or engine invocation behavior.

## Release & Deployment

Publishing the CLI package and deploying the Cloudflare GUI Worker are handled by GitHub Actions from pushed release tags. Do not run local commands that publish to npm or deploy the Worker directly. For releases, prepare and verify the version/tag locally, push the commit and tag, then let `.github/workflows/publish.yml` perform npm publish and Worker deployment with repository secrets. After pushing the tag, verify the Actions run, npm `latest`, and the deployed Worker status instead of retrying local publish.

## Security & Configuration Tips

This daemon bridges remote runtime events to local CLI processes and is not an OS sandbox. Treat `serverUrl`, `deviceToken`, runtime tokens, and per-agent homes under `~/.king-ai/` as sensitive. Do not log full tokens or persist secrets outside the existing config/token paths.
