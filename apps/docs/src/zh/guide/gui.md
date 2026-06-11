# GUI Runtime

GUI worker 是面向浏览器的 runtime app。它存储持久 GUI 状态、提供页面 shell、暴露配对 API、流式输出状态，并为卡片和 workflow 状态分发 runtime CLI 命令。

## 本地运行

在仓库根目录执行：

```sh
pnpm gui:dev
```

Wrangler 会打印本地 URL。默认开发地址通常是 `http://127.0.0.1:8787`。

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

在团队对话里，普通寒暄和面向全员的点名消息会留给协调者处理，不会自动创建 Dev 或 Reviewer 任务。明确的工作请求仍会按 workflow 任务和复核链路自动委派。

## 部署

Worker package 位于 `apps/gui-worker`。本地开发使用 Wrangler，但生产发布由版本 tag 触发的 GitHub Actions 完成。正常发布流程中不要手动 npm publish，也不要直接部署 Worker。
