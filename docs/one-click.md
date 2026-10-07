# 一键部署（macOS / Linux / Windows）

安装脚本会完成：检查/安装 Node 24 → 安装 CLI（memctl/memd）→ 配置模型 key →
安装 hooks（含 PreCompact）→ 注册 MCP → 安装后台 daemon 与 review 提醒 →
运行状态检查。

## macOS

```bash
# 本地仓库
cd ~/Github/mem && bash install.sh

# 远程引导（把 <RAW> 换成 raw 地址，<GIT> 换成仓库地址）
curl -fsSL <RAW>/install.sh | MEM_REPO_URL=<GIT> bash

# 或从打包 zip 安装
curl -fsSL <RAW>/install.sh | MEM_PACKAGE_URL=https://.../mem-v0.3.0.zip bash
```

## Linux

```bash
curl -fsSL <RAW>/install.sh | MEM_REPO_URL=<GIT> bash
```

安装 systemd user 单元：`mem-daemon.service` 与 `mem-review.timer`（每天 10:00）。
如需注销后继续运行：`sudo loginctl enable-linger $USER`。
日志：`journalctl --user -u mem-daemon -f`。

## Windows

```powershell
# 本地仓库（推荐先解压 zip 后执行）
powershell -ExecutionPolicy Bypass -File install.ps1

# 远程引导
$env:MEM_PACKAGE_URL = 'https://.../mem-v0.3.0.zip'
irm <RAW>/install.ps1 | iex
```

双击 `install.cmd` 也可以。脚本会用 winget 自动安装 Node 24（若缺失），
然后调用 `scripts\windows\install.ps1` 完成 hook / MCP / 计划任务安装。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEM_DIR` | 安装目录 | `~/Github/mem` |
| `MEM_REPO_URL` | 远程 git 仓库（clone/升级） | 空 |
| `MEM_PACKAGE_URL` | zip 包地址（无 git 时使用） | 空 |
| `MEM_SKIP_MODEL=1` | 跳过 key 配置（稍后手动配置） | 0 |
| `MEM_NODE_BIN` | 指定 node 路径 | 自动探测 |

## 幂等与升级

- 重复运行同一命令即可升级：已存在的目录会原地更新，hook/MCP/服务均覆盖安装并保留备份。
- 目录是 git 仓库且设置了 `MEM_REPO_URL` 时会执行 `git pull --ff-only`。
- 便携安装的 Node 位于 `~/.local/node`，不会覆盖系统 Node。
- 数据始终在 `~/.llm-memory`，升级不触碰。

## 安装后验证

```bash
memctl status          # 数据库统计
memctl sources         # cline / codex / generic
memctl tui             # 全功能 TUI
```

- VS Code 重启后检查 `Cline Settings > Hooks`（9 个）与 `MCP Servers`（mem 已连接）。
- Windows 额外：`Get-ScheduledTask mem-daemon | Select TaskName, State`。

## 卸载

- macOS：`bash scripts/uninstall-launchd.sh`，并按需删除 `~/Documents/Cline/Hooks` 中的 hook。
- Linux：`systemctl --user disable --now mem-daemon mem-review.timer` 后删除单元文件。
- Windows：`powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1`。
- 数据目录 `~/.llm-memory` 不会被卸载脚本删除，需手动清理（先备份）。
