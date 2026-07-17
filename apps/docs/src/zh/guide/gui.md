# GUI Runtime

GUI worker 是面向浏览器的 runtime app。它存储持久 GUI 状态、提供页面 shell、暴露配对 API、流式输出状态，并为卡片和 workflow 状态分发 runtime CLI 命令。

## 本地运行

在仓库根目录执行：

```sh
pnpm gui:dev
```

Wrangler 会打印本地 URL。默认开发地址通常是 `http://127.0.0.1:8787`。

## 鉴权

配置 Better Auth 后，未登录访问 `/` 会收到登录页。如果 GUI 已打开时浏览器登录会话过期，`/gui/*` 请求明确返回 `401 {"error":"login_required"}` 后，页面会回到 `/` 重新登录；其他 `401` 和 `403` 仍保持原有错误处理。Agent runtime token 由本地 runner 独立续期，不会触发浏览器跳转。

## 清空本地 DO 状态

Wrangler 会把每个租户的 `GuiState` Durable Object 持久化到 `apps/gui-worker/.wrangler/state/v3/do/`。如果要清掉本地 GUI 里的旧状态（例如内置 agent role 更新后），先停止 `pnpm gui:dev`，再执行：

```sh
pnpm gui:clear-do -- --yes
```

然后重新启动 `pnpm gui:dev`，让 Wrangler 创建全新的 DO sqlite 文件。

如果更想通过正在运行的 worker 重置（已配置鉴权时需要 owner 登录）：

```sh
pnpm gui:clear-do -- --remote --yes
```

非默认租户可加 `--tenant <id>`；对已部署实例可用 `--url https://your-gui.example --cookie "session=..."`。

## 配对面板

GUI 会展示两条命令：

- 首次配对命令，包含 `king-ai agent computer --pair ...`。
- 已配对电脑后续启动使用的命令。

在承载本地智能体的机器上运行配对命令。配对完成后，GUI 会等待 computer daemon 上线并上报可用引擎。

智能体 roster 状态和 composer 的运行中提示由本地 runner 的 runtime 心跳驱动。智能体运行时，runner 会每隔几秒刷新心跳。如果 runner 崩溃或电脑断连，导致它来不及上报 `avail`，GUI 会在约 15 秒后把过期的 busy 状态视为空闲，避免 `thinking`/`running` 指示永久卡住。

## 工作界面

GUI 提供：

- 对话和未读输入。
- 智能体 roster 和在线状态。
- 任务、文件、claim、评审、决策、initiative 和计划。
- 运行历史和 host command 输出。
- 开发和测试环境使用的 reset 控制。

当前每个内置 GUI 工作流都只有一个 agent。在 `software-dev` 中，所有请求都由 Dev 处理；实质性 turn 会记录为 Dev 自有任务，并在没有内置 Reviewer 或协调者二次总结的情况下关闭。共享的任务、评审、交接和决策原语仍供 CLI 工作流及未来花名册使用。

## 部署

Worker package 位于 `apps/gui-worker`。本地开发使用 Wrangler，但生产发布由版本 tag 触发的 GitHub Actions 完成。正常发布流程中不要手动 npm publish，也不要直接部署 Worker。
