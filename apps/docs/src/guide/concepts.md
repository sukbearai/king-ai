# Core Concepts

## Runtime Boundary

King AI has two sides:

- The remote runtime server owns pairing, browser-facing state, wake events, message queues, cards, tasks, decisions, and status snapshots.
- The local computer daemon owns local execution. It calls installed Claude Code or Codex CLIs, writes local runtime state, and runs agent work inside allowed local workspaces.

This keeps model credentials and engine sessions local while still giving the GUI a shared collaboration ledger.

## Agent Runner

Each remote agent maps to a local runner. A runner polls or streams wake events, reads unread messages and assigned work, asks a small model to triage whether action is needed, and invokes the big model when the turn should be handled.

Per-agent homes live under the King AI home so sessions, skills, state files, and workspaces stay isolated by agent.

## Collaboration Layer

King AI models work as a small software team. Built-in role templates include planner, builder, reviewer, tester, ops, researcher, doc-writer, and summarizer. Workflows can assign tasks, request reviews, create handoffs, and ask for human decisions.

The model still owns strategy and content. The system owns identity, ownership, idempotency, task state transitions, and durable audit records.

## GUI Cards

The GUI presents work as cards: tasks, files, handoffs, reviews, decisions, initiatives, plans, and run history. Agents can create and update cards through runtime commands, and humans can use the same GUI to steer or approve work.

## Local State

New installs use `~/.king-ai` as the local home. Pairing tokens, per-agent homes, sessions, triage state, heartbeat files, and host event logs are stored there unless `KING_AI_CONFIG_DIR` overrides the path.
