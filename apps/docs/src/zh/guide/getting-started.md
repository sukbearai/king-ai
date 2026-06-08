# 快速开始

King AI 把远端 runtime server 连接到你本机的智能体引擎。完成一次配对后，只要本机 Claude Code 或 Codex 保持登录，就可以启动 computer daemon 执行智能体工作。

## 前置条件

- Node.js 20 或更新版本。
- 用 `pnpm` 执行开发命令和一次性 `dlx` 命令。
- 至少安装并登录一个本地引擎：`claude` 或 `codex`。
- 一个能显示配对命令的 King AI GUI 或 runtime server。

## 检查本地引擎

配对前先运行 doctor。它会检查 PATH、引擎可用性，以及本地引擎是否能处理 big-brain 和 small-brain 请求。

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --doctor
```

源码开发时：

```sh
pnpm install
pnpm dev -- agent computer --doctor
```

## 配对本机

打开 GUI，复制首次配对命令，并在承载本地智能体的机器上运行。新的配对链接使用 `king-ai://pair?...` 格式，必要时会带上 server 和 tenant 信息。

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair 'king-ai://pair?...'
```

如果 GUI 只给了短 code，需要同时提供 runtime server URL：

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --pair <code> --server https://runtime.example
```

CLI 会把配对配置写入 `~/.king-ai/computer.json`，并把带 token 的本地状态保存在这台机器的 King AI home 中。

## 启动 Daemon

配对后，在前台启动 daemon：

```sh
pnpm dlx @suwujs/king-ai@latest agent computer
```

常用服务命令：

```sh
pnpm dlx @suwujs/king-ai@latest agent computer --install-service
pnpm dlx @suwujs/king-ai@latest agent computer --status
pnpm dlx @suwujs/king-ai@latest agent computer --logs
```

## 从源码开发

在仓库根目录通过 dev 脚本运行源码 CLI：

```sh
pnpm dev -- agent computer --pair <code> --server http://127.0.0.1:8787
pnpm dev -- agent computer --server http://127.0.0.1:8787
```

启动文档站：

```sh
pnpm docs:dev
```
