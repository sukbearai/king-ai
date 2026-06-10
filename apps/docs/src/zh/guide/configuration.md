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

## IELTS 教练语音

当 GUI Worker 配置了 Cloudflare Workers AI 的 `AI` binding 时，IELTS 教练消息会显示播放按钮。按钮会调用 `/gui/tts`，运行 `xai/grok-tts`，并把生成的音频流式返回浏览器。部署所在的 Cloudflare 账号需要具备 Workers AI 访问权限，并且有足够余额或 BYOK 配置。

播放范围只限 IELTS 教练消息。浏览器只会把教练回复中可读的英文部分发送给 TTS，并排除用于词卡和句子标注的隐藏 `WordCards` JSON。

播放按钮会显示加载中、播放中和失败状态。同一时间只播放一条回复；再次点击正在播放的按钮会停止播放；生成后的音频会缓存在当前页面会话的浏览器内存中，重复点击同一条消息不会重新生成。

`CLOUDFLARE_AI_GATEWAY_ID` 会为 TTS 调用启用 Cloudflare AI Gateway 路由。默认 Worker 配置把它设为 `default`，因此账号配置好 gateway 后，Workers AI 请求会进入该 gateway 的日志和治理链路。如果没有 `AI` binding，`/gui/tts` 可以用 `CLOUDFLARE_ACCOUNT_ID` 和 Worker secret `CLOUDFLARE_AI_API_TOKEN` fallback 到 Cloudflare REST `/ai/run` API。

REST fallback 默认关闭，只用于本地调试或少数无法使用 `AI` binding 的部署。只有设置 `CLOUDFLARE_AI_REST_FALLBACK=1` 时才会启用。

不要把 TTS 路由配置成 AI Gateway 的 `/compat/chat/completions` URL。这个 OpenAI-compatible 路径用于 chat completions；TTS 需要通过 binding 或 `/ai/run` 调用 Workers AI 的 `xai/grok-tts`。
