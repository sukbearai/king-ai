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
~/.king-ai/trade_config.json
~/.king-ai/trade/
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
- `KING_AI_SESSION_NO_OUTPUT_TIMEOUT_MS`：持久引擎 turn 没有任何可见输出时的 watchdog。默认值是 `300000`（5 分钟）；设为 `0` 可关闭。
- `KING_AI_SESSION_TIMEOUT_MS`：持久引擎 turn 的可选硬超时。默认关闭。
- `KING_AI_TURN_TIMEOUT_MS`：一次性引擎运行的可选硬超时。默认关闭。
- `KING_AI_TRADE_CONFIG`：覆盖交易配置文件路径（默认 `~/.king-ai/trade_config.json`）。
- `KING_AI_ALERT_LOG`：覆盖 trade 规则写入的告警 JSONL 审计日志路径。
- `KING_AI_SHARED_SKILLS`：一个或多个直接包含共享技能目录的根目录。多个根目录可以用系统路径分隔符或逗号分隔。daemon 会在启动本地引擎前，把每个包含 `SKILL.md` 的子目录复制到各智能体 home。
- `KING_AI_SKILL_SNAPSHOTS_DIR`：可选的技能激活快照目录，用于记录某次运行实际安装的共享技能文件。


## 交易运行时

交易信号使用 `~/.king-ai/trade/` 存放日志、scratchpad 状态、告警审计日志及 PANews 等 skill。安装 daemon 与规则配置见 [交易信号](/zh/guide/trade)。

## 共享技能

共享技能让操作者把一组外部流程挂载到每个本地智能体 home，而不需要把这些流程打包进 King AI 发布包。这适合私有团队技能，也适合 AI Builder Club 这类第三方 skill pack。

`KING_AI_SHARED_SKILLS` 指向的目录必须直接包含技能目录：

```text
/path/to/shared-skills/
├── dev-local-setup/
│   └── SKILL.md
└── new-loop/
    └── SKILL.md
```

如果 AI Builder Club checkout 放在当前仓库旁边，可以这样启用：

```sh
eval "$(pnpm skills:aibc:env)"
pnpm dev -- agent computer
```

在这台机器上，这个 helper 会解析为：

```sh
export KING_AI_SHARED_SKILLS='/Users/fayon/workspace/github/skills/skills/skills'
```

如果 checkout 在其他位置，可以显式传入根目录：

```sh
eval "$(pnpm skills:aibc:env /path/to/aibc/skills)"
```

启动时 daemon 会把共享技能安装到每个智能体 home 下的 `.claude/skills`、`.codex/skills` 和 `.grok/skills`。它也会把激活快照写到 `.king-ai/skill-snapshots`；如果配置了 `KING_AI_SKILL_SNAPSHOTS_DIR`，则写到该目录，便于审计某次运行实际拿到的技能内容。

## 本地引擎

King AI 会检测已安装的 `claude`、`codex` 和 `grok` CLI。启动 daemon 前保持选中的引擎在本机已登录，然后运行：

```sh
king-ai agent computer --doctor
```

来验证 PATH、登录或额度变化后的引擎可用性。

当某次 turn 明确绑定到单个 GUI 对话窗口时，持久引擎 session 会按窗口隔离。这样同一个窗口里的追问仍能沿用上下文，新建窗口不会继承另一个窗口的本地模型 transcript。后台 agenda work 和横跨多个对话的 turn 会继续使用默认的每智能体 session。

持久引擎 session 会启用无输出 watchdog。如果 Codex 或 Grok 等本地 CLI 卡在交互式登录、额度、账单或 credits 提示后没有产生任何引擎输出，King AI 会中止当前 attempt、重置受影响的 session、把 attempt 记录进 run attempt ledger，并同步显示在 run stream card 上，再针对同一批未读消息或 pinned task 安排一次有上限的重试，然后才进入退避。如果重试仍失败，King AI 会发送明确的 runtime failure notice，并在 GUI 的模型状态面板显示处理建议；此时先在本地终端直接运行对应引擎，再重新执行 `king-ai agent computer --doctor`，确认健康后再唤醒智能体。

Grok 通过 xAI CLI 的 headless 模式（`grok -p`）运行 turn，使用 `--output-format streaming-json`，并通过 `--resume <sessionId>` 复用 session。当 turn 带有已接受的图片附件时，King AI 会改用 `grok --prompt-json`，以 ACP 图片内容块（base64 载荷）发送，而不是纯文本 `-p`。脚本化运行时 King AI 还会传入 `--no-auto-update` 和 `--always-approve`。可通过 `KING_AI_GROK_ARGS` 追加可选参数。

## IELTS 教练语音

当 GUI Worker 配置了 Cloudflare Workers AI 的 `AI` binding 时，IELTS 教练消息会显示播放按钮。按钮会调用 `/gui/tts`，运行 `xai/grok-tts`，并把生成的音频流式返回浏览器。部署所在的 Cloudflare 账号需要具备 Workers AI 访问权限，并且有足够余额或 BYOK 配置。

播放范围只限 IELTS 教练消息，以及从这些消息打开的单词卡。整条消息播放时，浏览器只会把教练回复中可读的英文部分发送给 TTS，并排除用于词卡和句子标注的隐藏 `WordCards` JSON；单词卡播放时只发送当前单词。

播放按钮会显示加载中、播放中和失败状态。同一时间只播放一条回复；再次点击正在播放的按钮会停止播放；生成后的音频会缓存在当前页面会话的浏览器内存中，重复点击同一条消息不会重新生成。

`CLOUDFLARE_AI_GATEWAY_ID` 会为 TTS 调用启用 Cloudflare AI Gateway 路由。默认 Worker 配置把它设为 `default`，因此账号配置好 gateway 后，Workers AI 请求会进入该 gateway 的日志和治理链路。如果没有 `AI` binding，`/gui/tts` 可以用 `CLOUDFLARE_ACCOUNT_ID` 和 Worker secret `CLOUDFLARE_AI_API_TOKEN` fallback 到 Cloudflare REST `/ai/run` API。

REST fallback 默认关闭，只用于本地调试或少数无法使用 `AI` binding 的部署。只有设置 `CLOUDFLARE_AI_REST_FALLBACK=1` 时才会启用。

不要把 TTS 路由配置成 AI Gateway 的 `/compat/chat/completions` URL。这个 OpenAI-compatible 路径用于 chat completions；TTS 需要通过 binding 或 `/ai/run` 调用 Workers AI 的 `xai/grok-tts`。
