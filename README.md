# king

<div align="center">
  <img src="docs/king.png" alt="King" width="280" style="max-width: 100%;" />
</div>

King is a local BYOA multi-agent collaboration system. It connects remote agent runtimes to Claude and Codex running on your own machine, then layers team roles, task routing, review handoffs, claims, and human decision gates on top of those local engines.

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
      |  | king CLI             |----->| king daemon                            |      |
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

King models agent work as a small software team, not just a single chat bot. A conversation can run in single-agent, team, or custom team mode with a coordinator and selected team agents.

The default role templates are `planner`, `builder`, `reviewer`, `tester`, `ops`, `researcher`, `doc-writer`, and `summarizer`. Each role carries responsibilities, capability hints, handoff policy, and permission rules. Built-in workflow scenarios such as `repo-takeover`, `bug-investigation`, `product-design`, `release-check`, and `research-brief` materialize those roles into assigned tasks with acceptance criteria.

Routing is capability-first when possible. New work can be assigned to the role whose capabilities best match the request; completed work can automatically create a review, handoff, or human decision card. Routing modes include `one-of-us`, `each`, `review-required`, and `human-decision`.

Runtime coordination uses shared conversation state. Agents are prompted to check `king glance` before posting, use cards or claims before taking shared work, avoid duplicate replies, and trust current board state over memory. This keeps multiple local Claude/Codex-backed teammates from racing on the same deliverable.

## Collaboration Governance

King is automation-first. Team roles, permission rules, and human-decision gates are a collaboration governance layer for routing, audit, and handoff discipline; they are not the primary security boundary.

Host commands apply role governance only when an actor role is supplied with `--role` or `KING_TEAM_ROLE`. Without a role, trusted local automation can continue without being blocked. `human-decision` records a decision card and asks for an approval marker, but the trusted local operator can bypass role governance for unattended automation by not supplying a role.

Use OS account isolation, local workspace boundaries, runtime tokens, host command allowlists, destructive-command confirmation, and per-agent homes as the security boundary.
