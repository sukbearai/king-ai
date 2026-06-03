# king

`king` is a local BYOA agent daemon. It hosts remote agents on your own machine and drives a local `claude` or `codex` CLI from isolated per-agent homes.

This repository is a pnpm monorepo. The publishable CLI and host SDK package is `packages/cli` (`@suwujs/king`), while the optional Cloudflare demo runtime is an app in `apps/demo-worker`.

It implements the important mechanics:

- pair a machine with a remote runtime server
- detect local engines (`claude`, `codex`)
- create one persistent home per agent under `~/.king/agents/<agentId>`
- expose operator-approved workspace directories to agents through an explicit allowlist
- inject a `king` runtime shim into each engine PATH
- listen for runtime wake events over SSE and fall back to inbox polling
- run local small-brain inbox triage before invoking the main engine
- reuse Claude stream-json sessions and Codex app-server sessions where available
- filter noisy engine JSON logs into readable terminal summaries
- support same-turn steering for engines with a live session
- install a macOS LaunchAgent or Linux systemd user service
- write a local `heartbeat.json` liveness file for external monitors
- check npm for newer daemon versions and let supervised services restart when idle
- rotate `daemon.log` to `daemon.log.1` when it grows beyond the daemon limit
- scrub outer Codex/Claude/King runtime environment variables before spawning nested engines
- expose a `king` shim inside agent homes for runtime actions
- copy configured shared skills into each Claude and Codex agent home with activation snapshots
- provide a demo runtime with roster, inbox, messages, glance, replies, claims, board cards, calendar, docs, DMs, reactions, status, typing, thinking, run logs, and agenda wakes

King is a new product with a compact local-runtime implementation. The demo runtime focuses on the local BYOA protocol surface; production concerns such as real accounts, billing, persisted multi-team data, notifications, and deployment operations belong in the paired runtime server.

## Usage

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @suwujs/king dev -- agent computer --doctor
pnpm --filter @king/demo-worker dev

king agent computer --pair <code> --server https://your-runtime.example
king agent computer --server https://your-runtime.example
king agent computer --doctor
king agent computer --status
king agent computer --install-service
king agent computer --restart
king agent computer --watch
king agent computer --logs
king agent computer --prepare-worktrees
king agent computer --prepare-worktrees --yes
king agent computer --cleanup-worktrees
king agent computer --cleanup-worktrees --yes
king agent computer --stop
king agent computer --version
king usage
king host status --json
king host commands
king host run status --json
king host plan-run "review this repo" --project . --json
king host preflight "review this repo" --project .
king host prepare-run-layout "review this repo" --project . --run-id demo
king host submit-run "review this repo" --project . --json
king host run-requests --json
king host execute-run
king host emit-run-event demo app.note --message "reviewed"
king host watch-run demo --tail 20
king host run-results demo --json
king host run-heartbeat demo --json
king host run-meta demo --json
king host plan-export --workspace ./agent-workspace --repo . --json
king host export --workspace ./agent-workspace --repo . --output ./deliverables
king host timeline --json
king host policy export --json
king host serve --port 8799
king host serve --execute-runs
king skill-check ./skills
king project-profile .
```

`--install-service` creates a macOS LaunchAgent or Linux systemd user service. `--status` reports pairing, service state, live pid, running version, last heartbeat, last agent sync, workspace allowlist, hosted agents, run usage summaries, and categorized daemon events from `running.json`. `--watch` refreshes the same running-state view every few seconds for local debugging. `--logs` prints categorized recent events first, then tails the service log. `--restart` reloads the service on the latest published package. `--stop` removes the service and also kills foreground `agent computer` daemon processes discovered from `running.json` or the process table.

The daemon also writes `heartbeat.json` under the config directory (`~/.king/heartbeat.json`). It contains pid, run id, version, computer id, server URL, last tick time, and loop count, so external monitors can detect a hung local daemon without calling the remote runtime.

The server is expected to provide the same high-level endpoints used by the daemon:

- `POST /api/computers/pair`
- `GET /api/computers/me/agents`
- `POST /api/computers/heartbeat`
- `POST /api/agents/:agentId/runtime-token`
- `GET /runtime/wake-stream`
- `GET /runtime/inbox`
- `GET /runtime/inbox-triage/payload`
- `GET /runtime/agenda`
- `GET /runtime/roster`
- `POST /runtime/cli`
- `POST /runtime/status`
- `POST /runtime/runs`
- `POST /runtime/runs/:runId/heartbeat`
- `POST /runtime/runs/:runId/finish`
- `POST /runtime/typing`
- `POST /runtime/thinking/mark`
- `POST /runtime/thinking/unmark`
- `POST /runtime/events`
- `POST /runtime/notices`
- `POST /runtime/triage`

The included demo runtime supports a compact `king` command surface for local testing:

- `king inbox`
- `king messages <conversationId> [--tail n]`
- `king glance <conversationId>`
- `king agents [spawn|destroy]`
- `king roster`
- `king participants`
- `king preamble [--agent agent-id] [--reason wake|agenda] [--run run-id]`
- `king state export|import|reset`
- `king contacts [query]`
- `king whoami`
- `king reply <conversationId> <text>`
- `king reply <conversationId> --quote <messageId> <text>`
- `king send <agentId> <message> [--steer] [--type message|decision|blocker]`
- `king recv [--agent agent-id]`
- `king escalate <message>`
- `king route set|list|delete|emit <eventType> [--agent agent-id] [--source source] '<payload json>'`
- `king status`
- `king observe [--json] [--classification productive|idle|blocked|backlog_stuck|error]`
- `king loop tick|emit|classify|recent|snapshot [--json] [--type eventType] [--agent agent-id]`
- `king task create|list|get|update|done [--after a,b] [--path a,b]`
- `king initiative create|list|get|update [--goal text] [--status active|paused|completed|abandoned]`
- `king capsule create|list|mine|get|update [--paths a,b] [--owner agent-id]`
- `king merge enqueue|list|get|mark [--capsule id] [--task id] [--branch name]`
- `king agenda`
- `king card list|create|claim|move|done|release [--paths a,b]`
- `king calendar list|create [--cron "*/15 * * * *"]`
- `king claim <name> [--in <conversationId>] [--paths a,b]`
- `king unclaim <claimId>`
- `king dm <agentId> <text>`
- `king react <messageId> <emoji>`
- `king doc list|create|show|append|update`
- `king artifact put|list|get|check --kind <kind> --path <path> --source <source> --confidence <0-1>`
- `king context get|set|list|delete <key> [value]`
- `king hypothesis create|list|update [--status <status>] [--evidence artifact-ids]`
- `king eval parse|record|list|get '<json evaluation>' [--artifact id] [--initiative id]`
- `king feedback record|list|summary|get [--agent agent-id] [--completed true|false]`
- `king review record|list|get [--capsule id] [--coverage pct] [--checks true|false]`
- `king plan parse|apply '<json plan>' [--assign agent-id] [--initiative id]`
- `king safety check|request|list|get|approve|deny <action|approvalId>`

Set `KING_SHARED_SKILLS` to one or more directories containing skill folders. Each child directory with a `SKILL.md` is copied into both `.claude/skills/<skill>` and `.codex/skills/<skill>` inside every agent home when the daemon starts that agent:

```sh
export KING_SHARED_SKILLS="$HOME/shared-skills,$HOME/project-skills"
king agent computer --server http://localhost:8787
```

Each install also writes a King activation snapshot with a `manifest.json` under `.king/skill-snapshots/<snapshotId>` in the agent home. Override the snapshot root with `KING_SKILL_SNAPSHOTS_DIR`. The agent process receives `KING_AGENT_SKILL_SNAPSHOT_ID`, `KING_AGENT_SKILL_SNAPSHOT_PATH`, and `KING_AGENT_SKILL_SNAPSHOT_MANIFEST`, and the daemon publishes the same snapshot metadata in the `agent.started` runtime event.

Use `king skill-check [skillsDir]` to statically validate local `SKILL.md` files. It scans for `king` command references and reports stale command or subcommand names before the skills are installed or shared.

Use `king project-profile [path]` to render a King takeover preflight profile for a local repository. It is read-only and does not start the daemon: it reports languages, package managers, frameworks, CI, tests, code roots, package scripts, canonical docs, strategic themes, and a mission draft that can seed future agent instructions.

`king agents` renders a King local Agent Matrix from the same runtime state as `king roster`. In the demo runtime, `spawn` and `destroy` report that dynamic agents are unsupported; production runtimes can implement those subcommands server-side.

`king roster` and `king participants` return a tab-separated agent-state summary with engine, lifecycle, current status, model overrides, unread count, open claims, and active cards. `GET /runtime/roster` also returns the same data as structured `agentStates`.

`king preamble` implements King respawn context summary. The demo runtime also exposes `GET /runtime/preamble`, and the local daemon injects this optional preamble before wake and agenda prompts when a runtime supports it. The summary includes the current loop, run id, agent, relevant tasks, unread messages, shared context, and recent loop events.

The demo runtime state is stored in a Durable Object and can be snapshotted. Use `king state export` to capture a schema-tagged JSON snapshot, `king state import '<snapshot json>'` to restore it, and `king state reset` to clear the demo back to a fresh paired state. The same controls are available over HTTP as `GET /demo/export-state`, `POST /demo/import-state`, and `POST /demo/reset-state`.

`king observe` implements King loop classification for local debugging. It classifies the current demo runtime as `productive`, `idle`, `blocked`, `backlog_stuck`, or `error` from unread messages, dependency-blocked tasks, advanced tasks, in-review capsules, artifacts, and failed run finishes.

`king loop` implements King loop-event bus in a compact ring buffer. Use `king loop tick --run <id>` to start a loop iteration, `king loop emit queue.backlog --agent <id> --pending 2` for manual test events, `king loop classify` to classify the current loop from recorded events, and `king loop recent --type artifact.created` to inspect recent task, artifact, backlog, and classification events. Task status transitions, artifact creation, and routed external events are recorded automatically.

`king calendar create` accepts a one-shot `--at <iso>` reminder and a King 5-field `--cron <expr>` schedule. The demo runtime is request-driven, so cron entries are evaluated when `king agenda` or `/runtime/agenda` is read rather than by a background timer.

The demo task pool implements King task model: `king task create` accepts assignee, priority, dependency, result, and scope flags; `king task list` renders dependency-blocked tasks as `[blocked]`; `king task done` unblocks downstream tasks. It is an in-memory demo runtime feature, not a persistent production task database.

The demo initiative board implements King mission layer above tasks: `king initiative create <title> --goal <goal>` records priority, status, summary, and source paths. Tasks and capsules can link back with `--initiative <id>`, and initiative list/get shows related task and capsule counts.

The demo change-capsule pool implements King handoff object for larger work: `king capsule create --goal <goal> --paths a,b --owner <agent>` records branch, base commit, acceptance criteria, reviewer, task/initiative refs, and path scope. Active capsules report weak or high conflicts when paths or subsystems overlap.

The demo merge queue implements King serialized integration state without running local git. Use `king merge enqueue --capsule <id>` or `--branch <name>` to queue a branch, `king merge list|get` to inspect it, and `king merge mark <id> testing|merged|conflict|failed` to record review results. Marking a request `merged` also marks the linked capsule as `merged` and the linked task as `done`.

The demo artifact store implements King structured deliverable habit: `king artifact put` records kind, path, source, confidence, optional task id, inline content, and metadata JSON. Standard kinds are enforced unless `--allow-nonstandard` is supplied, and low-confidence artifacts can be reviewed with `king artifact list --unverified`. `king artifact check` validates King quality rules: standard kind, `domain/category/item` path, recognized source identifiers, confidence/source alignment, collection date, and units for financial artifacts.

The demo context store implements King shared key/value context: use `king context set <key> <value>` for durable team facts such as current decisions, active constraints, or project state, and `king context get <key>` / `king context list` to read them before acting.

The demo hypothesis tracker implements King divergent-thinking loop: use `king hypothesis create` to record a proposed path, `king hypothesis update --status active|validated|rejected|abandoned` to advance it, and `--evidence` to link supporting artifact ids.

The demo evaluation accepts King JSON scoring results with `scores[]`, default criteria of feasibility, risk, impact, and cost, and a `confidence` value. Use `king eval parse '<json>'` to compute weighted totals and the selected option, or `king eval record '<json>' --artifact <id>` to store the decision. Confidence below `0.7` is flagged as `requiresHumanApproval`.

The demo feedback tracker implements King `run_feedback` metrics. Use `king feedback record --agent <id> --completed true --tokens 1200 --duration-ms 3000` to record a run outcome, then `king feedback summary` to compare agents by success rate, average duration, token use, steering, human intervention, and optional quality score.

The demo review gate implements King CTO review habit. Use `king review record --capsule <id> --coverage 96 --checks true --acceptance true --scope true --tests true --regressions true` to record an approval. Coverage below `95`, failed checks, unmet acceptance, scope mismatch, weak tests, or regressions produce `changes_requested`. Approved reviews can move a queued merge request to `testing` when `--merge <id>` is supplied.

The demo execution planner accepts King JSON plans with `tasks[]`. Use `king plan parse '<json>'` to validate and summarize a plan, then `king plan apply '<json>' --assign <agent>` to create scoped demo tasks. Task dependencies written as titles are resolved to newly created task ids when earlier tasks in the plan share the same title.

The demo safety gate implements King approval model for irreversible actions. `king safety check git_commit` is auto-allowed, while actions such as `deploy_production`, `delete_data`, `financial_transaction`, and `modify_permissions` return approval-required. Use `king safety request <action> --reason <text>`, then `king safety approve <id>` or `king safety deny <id> --reason <text>` to record the human decision. This is an audit/coordination layer in the demo runtime, not an operating-system sandbox.

The demo message relay implements King lightweight agent handoff commands: `king send` queues a targeted message, `king recv` reads and marks pending messages for an agent, and `king escalate` posts a steering decision to a CEO-style agent when one exists.

The demo event router implements King external event subscriptions. Use `king route set github_issue --agent feedback` to subscribe an agent, then `king route emit github_issue --source github '{"title":"Login broken"}'` or `POST /runtime/events` with `{type, source, payload}` to deliver a system message only to matching subscribers.

Most daemon tuning variables use `KING_*` names, including server/config paths, turn and triage timeouts, polling intervals, and the Codex app-server disable flag.

Host run preflight detects a project `.env` file and reports its path as environment metadata, but it does not load or echo those values. Apps or explicit executors can decide whether to load project environment files; layout preparation stays secret-safe by default.

Engine invocation can also be customized with `KING_TRIAGE_ARGS`, `KING_CLAUDE_ARGS`, and `KING_CODEX_ARGS`. Supplying Claude or Codex run arguments disables that engine's persistent session mode and falls back to one-shot execution.

Agent configs may include `model` and `fastModel`; the daemon passes both through to the selected engine and restarts a runner when either value changes.

Agent configs may also include `lifecycle`: `on-demand` (default), `24/7`, `idle_cached`, or `disabled`. This daemon is runtime-event driven, so `on-demand`, `24/7`, and `idle_cached` are exposed mainly for runtime lifecycle and status reporting; `disabled` is enforced locally and prevents that agent from being hosted. `idle_cached` relies on the selected engine's existing session reuse behavior and does not add a separate cache layer. Claude uses CLI session resume; Codex can reuse an app-server thread when available, but that resume behavior is best-effort and falls back to a fresh thread.

King keeps its local-agent boundary intentionally selective. It includes per-agent homes, explicit workspaces, worktree planning, lifecycle labels, loop-event/result files, structured artifacts/tasks, host SDK shapes, and localhost app observability. Production agent coordination stays in the paired remote runtime instead of a separate local database authority. It also does not copy host credentials by default or expose a remote-control HTTP API. `king host serve` is localhost-only, advertises `remoteApi: false` in `/capabilities`, and only runs allowlisted host commands behind the same policy checks as the CLI.

Run usage is tracked per hosted agent from engine-reported token usage. Set `KING_TOKEN_BUDGET` to display budget state in `king usage`, `--status`, and `--watch`, and publish `agent.budget_warning` or `agent.budget_exceeded` runtime events when the threshold is crossed. `king usage` reads the current `running.json` and summarizes runs, failures, token totals, and grouping by engine, model, and agent. For King FinOps views, set `KING_USAGE_PRICING` to JSON such as `{"codex:gpt-5":{"inputPerMillionTokens":2,"cacheReadInputPerMillionTokens":0.5,"outputPerMillionTokens":10}}`; matching keys are `engine:model`, `model`, `engine:*`, `engine`, or `*`, and `GET /usage` plus host snapshots include optional USD cost estimates when pricing is configured. Budgets and cost estimates are observational; they do not stop the local engine.

Unread runtime messages are routed before they reach the engine prompt. The daemon classifies each message by route (`ignore`, `monitor`, `respond`, `steer`), priority (`normal`, `steer`, `urgent`), and type (`message`, `decision`, `blocker`, `approval`, `system`). Targeted messages, direct human messages, @mentions, blockers, approvals, and decisions are surfaced first; routed tags such as `steer/urgent/blocker` appear in inbox digests and the demo `king recv` output.

Engine failures are normalized into structured remediation advice. `king agent computer --doctor`, `--status`, `king host status --json`, and `king host serve` can surface whether a local engine is missing from PATH, not signed in, quota-limited, rate-limited, context-full, or in an unknown failure state, with next actions such as signing in locally or rerunning `king agent computer --doctor`.

`king host status --json` exposes the same local daemon state as an app-facing snapshot: pairing, capabilities, agents, usage, worktree plans, recent events, and a text status summary. This implements King host-SDK boundary in a compact form: an app can inspect and orchestrate the local daemon through a stable command/JSON contract instead of scraping terminal logs. `king host commands` lists the allowlisted local commands, `king host run status --json` runs one locally, `king host plan-run "review this repo" --project . --json` normalizes a reproducible run request, `king host preflight "review this repo" --project .` checks readiness without starting an agent, `king host prepare-run-layout "review this repo" --project . --run-id demo` materializes the planned local layout after confirmation, and `king host submit-run "review this repo" --project . --json` persists a pending app run request under the config directory. Host launch plans include read-only local git observation for takeover-style UIs: git root, active branch, upstream presence, ahead/behind counts, changed paths, and a best-effort PR URL when `gh` can report one. Prepared layouts create `loop-events.ndjson`, `results.tsv`, `.king/heartbeat.json`, and `meta.json` so apps have stable files for event streaming, liveness checks, and human-scannable loop summaries. When a submitted host-command run includes `options.outputDir`, `execute-run` updates `.king/heartbeat.json` and `meta.json` from `running` to `completed` or `failed` with the command and exit code, and appends matching `run.status` events to `loop-events.ndjson`. Manual `update-run` lifecycle changes refresh the same heartbeat and meta files and append the same status event when the request has an output directory. Apps and operators can also append custom run events such as `app.note`, `human.reviewed`, or `artifact.selected` with `king host emit-run-event <id> <type> --message "..."`, and those events are visible through the same `watch-run` stream. `king host watch-run <id> --tail 20` reads King loop events and refreshes `results.tsv` from all classified loops in the run output; pass `--type run.status` to inspect lifecycle transitions. `king host run-results <id> --json` reads the result rows directly; `king host run-heartbeat <id> --json` reads the run heartbeat through the same host command envelope; `king host run-meta <id> --json` reads the prepared run metadata and path index. Use `king host run-request <id> --json` to inspect one request, `king host update-run <id> running|completed|failed|cancelled --detail "..." --json` to append lifecycle state, and `king host execute-run [id]` to consume one pending request that explicitly declares a safe local executor.

`king host plan-export --workspace ./agent-workspace --repo . --json` previews a King output bundle: copied workspace deliverables plus `repo-status.txt`, `repo.patch`, `repo-staged.patch`, and `meta.json` when the repo is dirty. `king host export --workspace ./agent-workspace --repo . --output ./deliverables` writes that bundle under a generated run id. `meta.json` is a stable app-facing index with the export schema, run id, source paths, file counts, dirty state, and written files. It never writes to the source workspace or repository; it only copies files to the selected output directory and reads git status/diff.

Host commands are appended to `host-events.ndjson` under the config directory. `king host timeline --json` returns recent audit events with command name, success state, exit code, destructive flag, duration, and compact summaries. Pending app run requests and lifecycle updates are appended to `host-runs.ndjson` and can be listed with `king host run-requests --json` or filtered with `--status completed`. `execute-run` only consumes requests whose `executor` is `{ "kind": "host-command", "command": "status" | "usage" | "events" | "timeline" | "policy" | "doctor" | "plan-run" | "preflight" | "plan-export" }`; it rejects destructive commands, queue-management commands, and layout preparation. These logs are for app-facing observability and replay, not secret stores; large outputs such as patches are summarized instead of embedded.

Host command policy implements King safety-gate shape for app-facing actions. Read-only commands are allowed automatically; destructive commands such as `export` require explicit confirmation when called through `POST /commands/run`. Use `king host policy export --json`, `GET /policy/export`, or `{ "command": "policy", "input": { "command": "export" } }` to inspect the requirement. To validate a confirmation before running a destructive command, call `POST /policy/export` with `{ "confirmation": "allow:export" }` or `{ "confirmed": true }`. To run the destructive command from an app, include either `"confirmed": true` or `"confirmation": "allow:export"` in the action input. The direct `king host export ...` CLI path is treated as operator-confirmed because it is invoked from the local terminal.

`king host serve --port 8799` exposes the same snapshot through a localhost HTTP server with `/health`, `/capabilities`, `/status`, `/host/snapshot`, `/host/stream`, `/status/stream`, `/status.txt`, `/events`, `/timeline`, `/timeline/stream`, `/runs/stream`, `/usage`, `/doctor`, `/commands`, `/policy/:command`, and `POST /commands/run`. `GET /capabilities` returns the app-facing resource list, stream endpoints, command definitions, destructive commands, safe executor command allowlist, and localhost-only CORS policy. Browser or Electron frontends served from `localhost`, `127.0.0.1`, or `[::1]` can call the server directly; non-local origins are rejected during CORS preflight. `GET /host/snapshot?limit=20` returns the first-screen bundle for apps: status, capabilities, recent timeline events, and recent run requests. `GET /host/stream?interval=1000&limit=20` is the app-friendly combined SSE feed; each tick emits `status`, `timeline`, and `runs` frames on one connection. `GET /status/stream` emits only `status` frames with the same JSON shape as `/status`. `GET /timeline/stream?limit=20&interval=1000` emits `timeline` frames with recent host command audit events without adding new audit entries. `GET /runs/stream?limit=20&status=pending&interval=1000` emits `runs` frames so apps can watch submitted run requests without polling `/runs`; `GET /runs/:id/stream?interval=1000` emits one `run` frame for a specific request and includes the latest parsed heartbeat and meta snapshot when the run output is known. `GET /runs/:id/events?tail=20&type=loop.classified` reads the run's `loop-events.ndjson`, refreshes `results.tsv` from the complete stream when events exist, and returns filtered events plus classification summary; use `type=run.status` to read lifecycle transitions appended by `update-run` and `execute-run`. `POST /runs/:id/events` appends a custom host-app event to the same stream after resolving the run output directory. `GET /runs/:id/results` returns parsed `results.tsv` rows directly, falling back to deriving rows from `loop-events.ndjson` if the table has not been written yet. `GET /runs/:id/heartbeat` returns the parsed `.king/heartbeat.json` liveness file when the run output is known. `GET /runs/:id/meta` returns the parsed prepared-run `meta.json` path and session index when the run output is known. `GET /timeline?limit=20`, `GET /usage`, and `GET /doctor` return recent host command audit events, token usage, and engine diagnostics using the same command result envelope as their `king host ... --json` equivalents. The command endpoint only accepts allowlisted commands (`status`, `usage`, `events`, `timeline`, `policy`, `doctor`, `plan-run`, `preflight`, `prepare-run-layout`, `submit-run`, `run-requests`, `run-request`, `update-run`, `execute-run`, `emit-run-event`, `watch-run`, `run-results`, `run-heartbeat`, `run-meta`, `plan-export`, `export`); destructive process controls such as stop and restart are intentionally not exposed. For `preflight`, apps can send the run spec directly to `POST /runs/preflight`, for example `{ "goal": "...", "projectDir": ".", "options": { "engine": "codex" } }`, to receive available engines, effective engine, warnings/errors, suggested commands, launch summary, a King `session` object, config metadata, and a local `layout` plan. `session.llmModeLabel` is `hybrid-worker`, `codex-cli`, `claude-cli`, or `runtime-default`, so apps can render the selected local/worker mode without parsing summary text. `config` reports whether the run would use an explicit config path, project `agents.json`, or the built-in default; it does not return config file contents. `layout` reports the planned `.king-local/<runId>` base directory, generated config path, agent workspace, shared skills directory, git root, `loop-events.ndjson`, `results.tsv`, `.king/heartbeat.json`, `meta.json`, and whether that base directory already exists. Preflight only reports these paths; it does not create them. `POST /runs/prepare-layout` writes that layout after explicit confirmation, copying project `agents/` and `skills/` directories when present and refusing to overwrite an existing run layout unless `force` is set. It also creates an empty `loop-events.ndjson`, a header-only `results.tsv`, a prepared `.king/heartbeat.json`, and prepared-run `meta.json` so apps have stable files to watch before execution starts. When no config is supplied, it creates a King default CEO/dev/feedback agent config and writes missing per-agent `AGENT.md` guides without overwriting existing guides. For `export`, send `{ "command": "export", "input": { "workspaceRoot": "./agent-workspace", "repoRoot": ".", "outputDir": "./deliverables", "confirmation": "allow:export" } }`. The server only binds to `127.0.0.1`, `::1`, or `localhost`; it is not a remote API server and does not add an operating-system sandbox.

The host server also exposes app-friendly run resources that map to the same command policy: `POST /runs/plan` normalizes a launch plan, `POST /runs/preflight` checks readiness without queueing, `POST /runs/prepare-layout` materializes the local layout with `confirmation: "allow:prepare-run-layout"`, `POST /runs` stores a pending request, `GET /runs?limit=20&status=pending` lists requests, `GET /runs/:id` returns one request, `GET /runs/:id/events` reads loop events, `POST /runs/:id/events` appends a custom event, `GET /runs/:id/results` reads result rows, `GET /runs/:id/heartbeat` reads run liveness, `GET /runs/:id/meta` reads run metadata, `PATCH /runs/:id` appends a lifecycle update such as `{ "status": "completed", "detail": "done" }`, `POST /runs/:id/execute` consumes a specific safe executor, and `POST /runs/execute` consumes the next pending safe executor. Responses keep the same command result envelope (`ok`, `command`, `exitCode`, `text`, `json`) so apps can use either resource routes or `POST /commands/run`.

Export planning is also available as app resources. `POST /exports/plan` previews a workspace/repo export without writing files. `POST /exports` writes the export bundle and is still protected by the same destructive-command confirmation gate, so apps must include `{ "confirmation": "allow:export" }` or `{ "confirmed": true }` in the request body.

Add `--execute-runs` to `king host serve` when an app wants the localhost host server to poll and consume pending safe host-command run requests automatically. The default interval is 1000ms and can be changed with `--execute-runs-interval <ms>` or `KING_HOST_EXECUTE_RUNS_INTERVAL_MS`. This opt-in loop calls the same `execute-run` command and keeps the same safety restrictions.

Apps can import the typed host SDK through the package export `@suwujs/king/host-sdk` instead of hand-writing the HTTP calls:

```ts
import {
  createBrowserHostSdk,
  createDefaultHostSdkRunOptions,
  createRunOptions,
  createEnvBackedHostSdk,
  createHostSdk,
  createKingHostSdk
} from "@suwujs/king/host-sdk";

const host = createHostSdk({ baseUrl: "http://127.0.0.1:8799" });
const kingNamedHost = createKingHostSdk({ baseUrl: "http://127.0.0.1:8799" });
const envHost = createEnvBackedHostSdk();
const browserHost = createBrowserHostSdk({ port: 8799 });
const runDefaults = createDefaultHostSdkRunOptions({ runtime: "codex", codexModel: "gpt-5" });
const kingStyleDefaults = createRunOptions({ runtime: "codex", workerUrl: "http://127.0.0.1:1234", noBrain: true });
await host.waitForReady({ requireDaemon: true });
const capabilities = await host.capabilities();
const status = await host.status();
const usage = await host.usage();
const doctor = await host.doctor();
const snapshot = await host.snapshot(20);
for await (const frame of host.watch({ intervalMs: 1000, limit: 20 })) {
  if (frame.event === "snapshot") console.log(frame.data.status.computerId);
  if (frame.event === "status") console.log(frame.data.ok);
  break;
}
for await (const frame of host.hostStream({ intervalMs: 1000, limit: 20 })) {
  if (frame.event === "status") console.log(frame.data.computerId);
  if (frame.event === "runs") console.log(frame.data.length);
  break;
}
for await (const snapshot of host.statusStream({ intervalMs: 1000 })) {
  console.log(snapshot.computerId, snapshot.ok);
  break;
}
for await (const events of host.timelineStream({ intervalMs: 1000, limit: 20 })) {
  console.log(events.length);
  break;
}
for await (const requests of host.runRequestsStream({ intervalMs: 1000, limit: 20 })) {
  console.log(requests.length);
  break;
}
for await (const request of host.runRequestStream("run-id", { intervalMs: 1000 })) {
  console.log(request?.status);
  break;
}
for await (const state of host.runStateStream("run-id", { intervalMs: 1000 })) {
  console.log(state.request?.status, state.heartbeat?.lastTick, state.meta?.paths?.outputDir);
  break;
}
const plan = await host.preflight({ goal: "review this repo", projectDir: ".", options: { engine: "codex" } });
const runPlan = await host.run("review this repo", {
  projectDir: ".",
  runtime: "codex",
  codexModel: "gpt-5",
  workerUrl: "http://127.0.0.1:1234"
}, {
  threadSync: { threadId: "thread-1", syncUrl: "https://app.example/thread-1" },
  hooks: { source: "embedded-app" }
});
const request = await host.submitRun({ goal: "review this repo", projectDir: ".", options: { engine: "codex" } });
const preparedTakeover = await host.prepareTakeover({ projectPath: ".", runtime: "codex" });
console.log(preparedTakeover.preflight.json?.launchSummary);
for await (const frame of host.submitAndWatchRun({ goal: "review this repo", projectDir: ".", options: { engine: "codex" } })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "run") console.log(frame.data?.status);
  break;
}
for await (const frame of host.submitAndWatchRunState({ goal: "review this repo", projectDir: ".", options: { engine: "codex" } })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "state") console.log(frame.data.request?.status, frame.data.heartbeat?.status, frame.data.meta?.runId);
  break;
}
await host.emitRunEvent(request.json!.request.id, { type: "app.note", message: "reviewed in app" });
for await (const frame of host.runAndWatch("review this repo", { projectDir: ".", engine: "codex" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "run") console.log(frame.data?.status);
  break;
}
for await (const frame of host.runAndWatchState("review this repo", { projectDir: ".", engine: "codex" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "state") console.log(frame.data.request?.status, frame.data.heartbeat?.loopCount);
  break;
}
for await (const frame of host.takeoverAndWatch({ projectPath: ".", engine: "codex" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "run") console.log(frame.data?.status);
  break;
}
for await (const frame of host.takeoverAndWatchState({ projectPath: ".", engine: "codex" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "state") console.log(frame.data.request?.status, frame.data.meta?.status);
  break;
}
for await (const frame of host.executePreparedTakeover(preparedTakeover, { requestId: "takeover-1" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "run") console.log(frame.data?.status);
  break;
}
for await (const frame of host.executePreparedTakeoverState(preparedTakeover, { requestId: "takeover-2" })) {
  if (frame.event === "submitted") console.log(frame.data.json?.request.id);
  if (frame.event === "state") console.log(frame.data.request?.status);
  break;
}
await host.updateRun(request.json!.request.id, "completed", "done");
await host.completeRun(request.json!.request.id, "accepted");
await host.failRun(request.json!.request.id, "failed by app");
await host.cancelRun(request.json!.request.id, "cancelled by app");
const finished = await host.waitForRun(request.json!.request.id, { timeoutMs: 30_000 });
const executed = await host.executeRun();
const immediate = await host.submitAndExecuteRun({
  goal: "refresh host usage",
  executor: { kind: "host-command", command: "usage", format: "json" }
});
const exportPlan = await host.planExport({ workspaceRoot: "./agent-workspace", repoRoot: ".", outputDir: "./deliverables" });
const exported = await host.exportArtifacts({ workspaceRoot: "./agent-workspace", repoRoot: ".", outputDir: "./deliverables", confirmation: "allow:export" });
const policy = await host.policy("export");
```

`createEnvBackedHostSdk()` reads `KING_HOST_URL`, or `KING_HOST` / `KING_HOST_PORT`, so desktop apps can reuse the same localhost settings as the CLI without hard-coding the endpoint. Browser or Electron renderers can use `createBrowserHostSdk({ port: 8799 })`; it derives a local host URL from `window.location` when possible and falls back to `127.0.0.1`, avoiding Node-only environment access. Streaming helpers work with both Node fetch bodies and browser `ReadableStream` bodies. `createDefaultHostSdkRunOptions()`, `createHostSdkRunOptions()`, and `createHostSdkTakeoverRunOptions()` expose King run defaults for app integrations; `createDefaultRunOptions()`, `createRunOptions()`, `createTakeoverRunOptions()`, `createKingHostSdk()`, and `createEnvBackedKingHostSdk()` are convenience helpers. When `createKingHostSdk(config, adapters)` receives adapters, it uses the local binding factory shape instead of the localhost HTTP client; without adapters it returns the HTTP SDK. The SDK accepts friendly option aliases such as `runtime`, `codexModel`, `pollInterval`, `output`, `keep`, `configPath`, `workerUrl`, `workerModel`, `workerKey`, `noBrain`, and `enableBrain`; explicit fields like `engine`, `model`, `pollIntervalSeconds`, `outputDir`, and `keepArtifacts` take precedence. Project run specs accept `threadSync`, `githubToken`, and `hooks` metadata; token, sync secret, and worker key values stay in structured data and are not rendered in summaries. `host.watch()` yields an initial `snapshot` frame, then continues with the combined `/host/stream` frames, which is the simplest app bootstrap path. `host.run(goal, options)` and `host.takeover(options)` use friendly app input shapes and return a local `preflight`/launch plan. `host.prepareTakeover(options)` returns that preflight plan plus the normalized takeover input, so apps can render or confirm it before calling `host.executePreparedTakeover(prepared)`. `host.runAndWatch(goal, options)` and `host.takeoverAndWatch(options)` use those same friendly input shapes, persist the run, and stream its request lifecycle; the `State` variants also stream parsed heartbeat and meta snapshots for app progress views. `host.submitRun(input)` persists a fully specified request for an app or future executor to pick up; `host.submitAndWatchRun(input)` does the same and immediately streams that run's lifecycle frames, while `host.submitAndWatchRunState(input)` streams `{ request, heartbeat, meta }` frames. `host.emitRunEvent(id, event)` appends app-side notes, review markers, and UI decisions into the same run event stream as loop and lifecycle events. `host.runRequest(id)`, `host.runStateStream(id)`, `host.runRequests(limit, status)`, `host.waitForRun(id)`, `host.updateRun(id, status, detail)`, `host.completeRun(id)`, `host.failRun(id)`, `host.cancelRun(id)`, `host.executeRun(id?)`, and `host.submitAndExecuteRun(input)` provide the app-facing lifecycle surface. `executeRun` currently executes only explicit safe host-command executors; it does not start a Claude/Codex task session by itself.

Host home configuration is opt-in. Set `KING_HOST_HOME_ENTRIES` to a comma-separated list of host-home dotfiles or dot directories, such as `.gitconfig,.npmrc`, to symlink them into each agent home. Entries must be single dot entries under the operator's home; nested paths and non-dot names are rejected. Use this sparingly for credentials and config the agent actually needs.

Workspace access is explicit. By default, the daemon reports `~/workspace` only when that directory exists. Override it with `KING_WORKSPACES` using comma-separated paths or the platform path delimiter:

```sh
export KING_WORKSPACES="$HOME/workspace/github,$HOME/src"
king agent computer --server http://localhost:8787
```

The daemon sends this capability during pairing and heartbeat. Inside the agent process, the same list is available as `KING_AGENT_WORKSPACES`, while `KING_AGENT_HOME` points at the private agent home.

For future worktree-style isolation, you can also set `KING_AGENT_WORKSPACE_ROOT`. Each hosted agent receives its own workspace root under that base, exposed as `KING_AGENT_WORKSPACE_ROOT` inside the engine process and shown in `--status` / `--watch`. When an allowed workspace is a git repository, the daemon also computes a worktree plan and exposes it as `KING_AGENT_WORKTREE_PLAN`. Plans include the `origin` URL when it is a valid GitHub repository remote. The daemon does not run `git worktree add` automatically. Use `king agent computer --prepare-worktrees` to dry-run the plans from the current `running.json`, then rerun with `--yes` to create missing worktrees. Use `king agent computer --cleanup-worktrees` to dry-run removal of planned worktrees that still exist, then rerun with `--yes` to call `git worktree remove --force` for those paths.

## Security Model

This is a CLI bridge, not an operating-system sandbox. It gives local engines broad file-system access inside their process. The daemon creates per-agent homes and prompts the engine to stay inside them, but the real boundary is trust in the configured runtime server and the local engine process.
