# Windows 部署指南（VS Code + Cline）

与 macOS 版本功能完全一致，差异只在系统集成层：hook 使用 `.ps1`，服务使用任务计划程序，通知使用 Windows 气泡。

## 前置条件

- Windows 10/11
- Node.js 24+（官网安装包或 nvm-windows）
- PowerShell 5.1+（系统自带）或 PowerShell 7
- 代码放在例如 `C:\Users\<you>\Github\mem`

## 安装步骤

在 PowerShell 中执行（如果脚本被策略拦截，加 `-ExecutionPolicy Bypass`）：

```powershell
cd $HOME\Github\mem

# 1. 配置模型 key（隐藏输入，写入 %USERPROFILE%\.llm-memory\config.json，不带 BOM）
powershell -ExecutionPolicy Bypass -File scripts\windows\configure-model.ps1

# 2. 安装 9 个 hook（写入 文档\Cline\Hooks\*.ps1）
powershell -ExecutionPolicy Bypass -File scripts\windows\install-hooks.ps1

# 3. 注册 MCP server（写入 %USERPROFILE%\.cline\data\settings\cline_mcp_settings.json）
powershell -ExecutionPolicy Bypass -File scripts\windows\install-mcp.ps1

# 4. 注册 daemon 计划任务（登录自启），可选每日 review 提醒
powershell -ExecutionPolicy Bypass -File scripts\windows\install-service.ps1 -WithReviewReminder
```

重启 VS Code，然后检查：

- `Cline Settings > Hooks` 能看到 9 个 hook
- `Cline MCP Servers` 里 `mem` 已连接

## 与 macOS 的差异

| 项目 | macOS | Windows |
|---|---|---|
| Hook 文件 | `~/Documents/Cline/Hooks/<Event>`（无扩展名，755） | `%USERPROFILE%\Documents\Cline\Hooks\<Event>.ps1`（文件存在即启用） |
| Hook 执行 | 直接执行脚本 | `powershell -File <Event>.ps1`（Cline 官方行为） |
| 服务管理 | launchd | 任务计划程序 `mem-daemon`（登录时启动） |
| 通知 | osascript | NotifyIcon 气泡 |
| 编码 | 默认 UTF-8 | hook-runner 按 UTF-8 字节透传，避免 PowerShell 5.1 ASCII 编码问题 |
| 数据目录 | `~/.llm-memory` | `%USERPROFILE%\.llm-memory` |
| Cline 数据 | `~/.cline/data` | `%USERPROFILE%\.cline\data` |

Windows 上 hook 的启用状态不看可执行位；只要 `.ps1` 文件存在就会执行。

## 常用命令

```powershell
node src\cli\memctl.ts review
node src\cli\memctl.ts metrics
node src\cli\memctl.ts report
node src\cli\memctl.ts auto on --quiet 15

Get-ScheduledTask mem-daemon | Start-ScheduledTask
Get-ScheduledTask mem-daemon | Stop-ScheduledTask
Get-Content $HOME\.llm-memory\logs\memd.out.log -Tail 20

# 全功能 TUI（Windows Terminal / PowerShell 均可）
memctl tui            # 9 屏应用：Dashboard/Sessions/Search/Candidates/Active/Skills/Tasks/Metrics/Config
memctl tui --review   # 只看候选审核

# 中文显示异常时（老版控制台代码页）
chcp 65001

# 卸载
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1
```

## 故障排查

| 现象 | 处理 |
|---|---|
| hook 不执行 | 文件名必须是 `<事件名>.ps1`；位于 `文档\Cline\Hooks`；重启 VS Code |
| 中文乱码 | 确认使用仓库自带 `hook-runner.ps1`（字节级 UTF-8 转发），不要手改 hook 文件编码 |
| JSON 解析失败 | 配置类 JSON 必须无 BOM；安装脚本已用 `UTF8Encoding($false)` 写入 |
| OneDrive 重定向了文档目录 | `install-hooks.ps1` 会读取注册表 `User Shell Folders\Personal`，自动定位真实文档目录 |
| nvm-windows 切换 Node 版本后服务失效 | 重新运行 `install-service.ps1`（计划任务里是 Node 绝对路径） |
| PowerShell 策略限制 | 安装时用 `-ExecutionPolicy Bypass`；Cline 自身以 `powershell -File` 执行 hook |
| 通知不弹 | 检查系统通知设置；`review --notify` 失败不影响命令本身 |
| daemon 无输出 | 日志同时写入 `%USERPROFILE%\.llm-memory\logs\memd.out.log` |
| TUI 中文乱码 | 用 Windows Terminal，或先执行 `chcp 65001`；TUI 启动时会自动尝试切换 UTF-8 |
| TUI 无法启动（非交互） | 在管道/CI 中会自动降级为文本清单，这是预期行为 |

## 未在 Windows 实机验证的项

本仓库在 macOS 上开发与测试（23 项自动化测试通过）。Windows 层（PowerShell hook、任务计划、通知）为静态实现，首次部署时请按上述检查项逐条验证；如遇问题，把 PowerShell 报错原文贴回即可。
