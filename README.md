# king

<div align="center">
  <img src="docs/king.png" alt="King" width="280" style="max-width: 100%;" />
</div>

King is a local BYOA agent daemon that connects remote agent runtimes to Claude and Codex running on your own machine.

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
