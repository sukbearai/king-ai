# CLI Reference

The published package is `@suwujs/king-ai`, and the binary is `king-ai`.

## Doctor

```sh
king-ai agent computer --doctor
```

Checks installed engines, PATH, login or quota health, and whether at least one engine can handle both big-brain and small-brain calls.

## Pair

```sh
king-ai agent computer --pair 'king-ai://pair?...'
king-ai agent computer --pair <code> --server https://runtime.example
```

Pair this machine with a runtime server. The GUI normally gives a full `king-ai://pair?...` locator. A short code also works when paired with `--server`.

Options:

- `--engine claude|codex`: prefer one installed engine.
- `--tenant <id>`: select a tenant on multi-tenant GUI servers.
- `--server <url>`: override the default runtime server URL.

## Run

```sh
king-ai agent computer
king-ai agent computer --server https://runtime.example
```

Starts the local computer daemon in the foreground. The machine must already be paired.

## Background Service

```sh
king-ai agent computer --install-service
king-ai agent computer --restart
king-ai agent computer --stop
king-ai agent computer --status
king-ai agent computer --logs
king-ai agent computer --watch
```

Use these commands after pairing when you want the daemon to survive terminal sessions.

## Worktrees

```sh
king-ai agent computer --prepare-worktrees
king-ai agent computer --prepare-worktrees --yes
king-ai agent computer --cleanup-worktrees
king-ai agent computer --cleanup-worktrees --yes
```

These commands inspect the running daemon state and show or apply planned workspace changes for local agent worktrees.

## Development Shortcut

Inside this repository, use the root dev script instead of a globally installed binary:

```sh
pnpm dev -- agent computer --doctor
pnpm dev -- agent computer --pair <code> --server http://127.0.0.1:8787
pnpm dev -- agent computer --server http://127.0.0.1:8787
```
