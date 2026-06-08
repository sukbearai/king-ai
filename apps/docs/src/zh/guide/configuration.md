# 配置

## 本地 Home

新安装会把本地运行时状态存储在：

```text
~/.king-ai
```

测试或隔离开发时可以覆盖这个路径：

```sh
KING_AI_CONFIG_DIR=/tmp/king-ai-dev king-ai agent computer --doctor
```

用户安装和文档说明应使用 `~/.king-ai`。这是新项目路径， fresh install 不需要创建单独的旧 home。

## 重要文件

```text
~/.king-ai/computer.json
~/.king-ai/agents/
~/.king-ai/sessions/
~/.king-ai/triage/
~/.king-ai/running.json
~/.king-ai/heartbeat.json
~/.king-ai/host-events.ndjson
~/.king-ai/host-runs.ndjson
```

- `computer.json` 保存已配对的 server URL、computer ID、tenant ID 和 device token。
- `agents/` 保存每个智能体的 home 和生成的运行时文件。
- `sessions/` 和 `triage/` 保存本地模型会话和 triage 状态。
- `running.json` 和 `heartbeat.json` 描述当前运行的 daemon。
- host event 日志是本地追加式审计文件。

这个目录包含 runtime token 和本地执行状态，应按敏感目录处理。

## 环境变量

- `KING_AI_CONFIG_DIR`：覆盖本地 home。
- `KING_AI_SERVER_URL`：覆盖默认 runtime server URL。生产环境默认值是 `https://king-ai.congrongtech.cn`。
- `KING_AI_TEAM_ROLE`：为 host command governance 提供 actor role。
- `KING_AI_AGENT_WORKSPACE_ROOT`：在开发中限制或指定智能体 workspace 准备路径。

## 本地引擎

King AI 会检测已安装的 `claude` 和 `codex` CLI。启动 daemon 前保持选中的引擎在本机已登录，然后运行：

```sh
king-ai agent computer --doctor
```

来验证 PATH、登录或额度变化后的引擎可用性。
