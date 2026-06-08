# CLI 参考

发布包名是 `@suwujs/king-ai`，命令行 binary 是 `king-ai`。

## Doctor

```sh
king-ai agent computer --doctor
```

检查已安装引擎、PATH、登录或额度状态，并确认至少一个引擎能处理 big-brain 和 small-brain 调用。

## 配对

```sh
king-ai agent computer --pair 'king-ai://pair?...'
king-ai agent computer --pair <code>
```

把这台机器配对到 runtime server。GUI 通常会给出完整的 `king-ai://pair?...` locator。短 code 默认使用生产 server。

选项：

- `--engine claude|codex`：优先使用一个已安装引擎。
- `--tenant <id>`：选择多租户 GUI server 上的 tenant。
- `--server <url>`：覆盖默认 runtime server URL。生产环境默认值是 `https://king-ai.congrongtech.cn`。

## 运行

```sh
king-ai agent computer
king-ai agent computer --server https://runtime.example
```

在前台启动本地 computer daemon。机器必须已经配对。

## 后台服务

```sh
king-ai agent computer --install-service
king-ai agent computer --restart
king-ai agent computer --stop
king-ai agent computer --status
king-ai agent computer --logs
king-ai agent computer --watch
```

配对后使用这些命令，让 daemon 不依赖当前终端会话。

## Worktrees

```sh
king-ai agent computer --prepare-worktrees
king-ai agent computer --prepare-worktrees --yes
king-ai agent computer --cleanup-worktrees
king-ai agent computer --cleanup-worktrees --yes
```

这些命令会读取运行中 daemon 的状态，展示或应用本地智能体 worktree 的计划变更。

## 开发快捷命令

在本仓库内，用根目录 dev 脚本代替全局安装命令：

```sh
pnpm dev -- agent computer --doctor
pnpm dev -- agent computer --pair <code> --server http://127.0.0.1:8787
pnpm dev -- agent computer --server http://127.0.0.1:8787
```
