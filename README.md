# king-ai

King AI is a local BYOA multi-agent collaboration system. It connects remote agent runtimes to Claude and Codex running on your own machine, then layers team roles, task routing, review handoffs, claims, and human decision gates on top of those local engines.

Repository: `sukbearai/king-ai`.

Packages:

- CLI: `@suwujs/king-ai`, exposing the `king-ai` command.
- GUI worker app: `@king-ai/gui-worker`.

The primary CLI command is `king-ai`. Local runtime state lives under `~/.king-ai`; existing `~/.king/computer.json` is read only as a one-time upgrade fallback when the new config has not been written yet.

## Install And Develop

```sh
pnpm install
pnpm verify
pnpm dev -- agent computer --doctor
```

The GUI worker can be run locally with:

```sh
pnpm gui:dev
```

## Rename And Migration Notes

This project was renamed to `king-ai`. New installs and generated commands should use only `king-ai`, `@suwujs/king-ai`, `@king-ai/gui-worker`, `KING_AI_*`, `king-ai://`, and `~/.king-ai`.

The old `king` command is not exposed as a bin alias. The only retained legacy behavior is reading `~/.king/computer.json` when the new `~/.king-ai/computer.json` has not been written yet, so an already paired computer can migrate without losing its token.

## Architecture

```text
                      +------------------------------------------------+
                      |             Remote Runtime Server              |
                      |  pair / roster / inbox / wake-stream / status  |
                      +------------------------+-----------------------+
                                                           |
                                                           v
      +--------------------------------------------------------------------------------+
      |                                Local Machine                                   |
      |                                                                                |
      |  +----------------------+      +----------------------------------------+      |
      |  | king-ai CLI          |----->| King AI daemon                         |      |
      |  | status / run / logs  |      | pairing, heartbeat, SSE, host SDK      |      |
      |  +----------------------+      +-------------------+--------------------+      |
      |                                                   |                            |
      |                                                   v                            |
      |                                +----------------------------------------+      |
      |                                | agent runner                          |       |
      |                                | triage, prompts, session reuse        |       |
      |                                +-------------------+--------------------+      |
      |                                                   |                            |
      |                         +-------------------------+---------------------+      |
      |                         |                                               |      |
      |                         v                                               v      |
      |              +--------------------+                  +--------------------+    |
      |              | Claude CLI         |                  | Codex CLI          |    |
      |              +---------+----------+                  +----------+---------+    |
      |                        |                                      |                |
      |                        +------------------+-------------------+                |
      |                                           |                                    |
      |                                           v                                    |
      |                                +----------------------------------------+      |
      |                                | per-agent home                        |       |
      |                                | skills, runtime shim, state files     |       |
      |                                +-------------------+--------------------+      |
      |                                                   |                            |
      |                                                   v                            |
      |                                +----------------------------------------+      |
      |                                | allowed local workspaces              |       |
      |                                | source repos, worktrees, artifacts    |       |
      |                                +----------------------------------------+      |
      +--------------------------------------------------------------------------------+
```

## Multi-Role Collaboration

King AI models agent work as a small software team, not just a single chat bot. A conversation can run in single-agent, team, or custom team mode with a coordinator and selected team agents.

The default role templates are `planner`, `builder`, `reviewer`, `tester`, `ops`, `researcher`, `doc-writer`, and `summarizer`. Each role carries responsibilities, capability hints, handoff policy, and permission rules. Built-in workflow scenarios such as `repo-takeover`, `bug-investigation`, `product-design`, `release-check`, and `research-brief` materialize those roles into assigned tasks with acceptance criteria.

Routing is capability-first when possible. New work can be assigned to the role whose capabilities best match the request; completed work can automatically create a review, handoff, or human decision card. Routing modes include `one-of-us`, `each`, `review-required`, and `human-decision`.

Runtime coordination uses shared conversation state. Agents are prompted to check `king-ai glance` before posting, use cards or claims before taking shared work, avoid duplicate replies, and trust current board state over memory. This keeps multiple local Claude/Codex-backed teammates from racing on the same deliverable.

## Collaboration Governance

King AI is automation-first. Team roles, permission rules, and human-decision gates are a collaboration governance layer for routing, audit, and handoff discipline; they are not the primary security boundary.

Host commands apply role governance only when an actor role is supplied with `--role` or `KING_AI_TEAM_ROLE`. Without a role, trusted local automation can continue without being blocked. `human-decision` records a decision card and asks for an approval marker, but the trusted local operator can bypass role governance for unattended automation by not supplying a role.

Use OS account isolation, local workspace boundaries, runtime tokens, host command allowlists, destructive-command confirmation, and per-agent homes as the security boundary.
