# GUI Runtime

The GUI worker is the browser-facing runtime app. It stores durable GUI state, serves the page shell, exposes pairing APIs, streams status, and dispatches runtime CLI commands for cards and workflow state.

## Run Locally

From the repository root:

```sh
pnpm gui:dev
```

Wrangler prints the local URL. The default development server is usually `http://127.0.0.1:8787`.

## Clear Local DO State

Wrangler persists each tenant's `GuiState` Durable Object under `apps/gui-worker/.wrangler/state/v3/do/`. To wipe stale local GUI state (for example after built-in agent role changes), stop `pnpm gui:dev`, then run:

```sh
pnpm gui:clear-do -- --yes
```

Restart `pnpm gui:dev` afterward so Wrangler opens fresh DO sqlite files.

To reset through the running worker instead (owner login required when auth is configured):

```sh
pnpm gui:clear-do -- --remote --yes
```

Pass `--tenant <id>` when you need a non-default tenant, or `--url https://your-gui.example --cookie "session=..."` for a deployed worker.

## Pairing Panel

The GUI shows two commands:

- A first-time pairing command with `king-ai agent computer --pair ...`.
- A start command for an already paired computer.

Run the pairing command on the machine that should host local agents. After pairing, the GUI waits for the computer daemon to come online and report available engines.

## Work Surfaces

The GUI exposes:

- Conversations and unread input.
- Agent roster and online status.
- Tasks, files, claims, reviews, decisions, initiatives, and plans.
- Run history and host command output.
- Reset controls for development and test environments.

## Deployment

The worker package lives in `apps/gui-worker`. Local development uses Wrangler, but production publishing is handled by the repository release workflow after a version tag is pushed. Do not publish the CLI package or deploy the Worker manually as part of normal releases.
