# Windows 部署与验证指南（Step by Step）

本文同时定义发布打包流程，后续每个版本按同一流程分发。

## 0. 总览

```
macOS 打包 → 传输 zip → Windows 解压 → 一键安装 → verify 校验 → VS Code 功能验收
```

## 1. macOS：提交并打包

```bash
cd ~/Github/mem
git add -A
git commit -m "feat(windows): PowerShell hooks, Task Scheduler, packaging"
bash scripts/package.sh
```

预期输出：

```
package : ~/Github/mem/dist/mem-v0.3.0.zip
sha256  : <hash>  mem-v0.3.0.zip
size    : 116K
```

包内包含：`src/ scripts/ docs/ tests/ phase0/ package.json`；
不包含：`.git`、`var/`、`node_modules/`、`dist/`、任何数据库和密钥。

传输方式任选：AirDrop / U 盘 / OneDrive / `scp`。

## 2. Windows 前置检查

```powershell
node -v            # 必须是 v24 或更高
$PSVersionTable.PSVersion   # 5.1 或 7 均可
```

安装：Node.js 24（官网 LTS 或 nvm-windows）、VS Code、Cline 插件。

## 3. 解压与一键安装

把 zip 解压到 `C:\Users\<you>\Github\mem`（路径不要有中文），然后：

```powershell
cd $HOME\Github\mem
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -WithReviewReminder
```

`install.ps1` 会依次执行：

1. `install-hooks.ps1`：写入 9 个 `<事件>.ps1` + `_mem-hook-runner.ps1`
2. `install-mcp.ps1`：在 `%USERPROFILE%\.cline\data\settings\cline_mcp_settings.json` 注册 `mem`
3. `configure-model.ps1`：交互输入 key，写入 `%USERPROFILE%\.llm-memory\config.json`（无 BOM、ACL 收紧）
4. `install-service.ps1`：注册计划任务 `mem-daemon`（登录自启），可选 `mem-review`（每日 10:00）
5. `verify.ps1`：静态检查 + `memctl status`

预期最后两行：

```
all checks passed
Next: restart VS Code, then check Cline Settings > Hooks and MCP Servers.
```

不想现在填 key：加 `-SkipModel`，之后单独运行 `configure-model.ps1`。

## 4. 验证清单

自动化部分（安装时已跑，可重复）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\verify.ps1 -ExpectTasks
```

VS Code 部分：

1. 重启 VS Code。
2. `Cline Settings > Hooks`：应列出 9 个 hook。
3. `Cline MCP Servers`：`mem` 显示已连接。
4. 新建一个 Cline 任务，发送：

```
用 mem_recall 搜索任意关键词，并说明你收到的记忆段落名。
```

预期：模型调用 `mem_recall`；若历史有命中，回答里出现 `<memory>` 相关段落（hint/taste/pitfalls/cards/past 之一）。

daemon 与采集：

```powershell
Get-ScheduledTask mem-daemon | Select-Object TaskName, State
Get-Content $HOME\.llm-memory\logs\memd.out.log -Tail 5
node src\cli\memctl.ts status
node src\cli\memctl.ts metrics
```

预期：任务 State=Running；日志有 `watching hooks=...`；status 显示 sessions/turns/cards 计数。

## 5. 功能验收

| 项目 | 操作 | 预期 |
|---|---|---|
| 采集 | 发一次 Cline prompt | `status` 的 hook events 增加；`raw\hooks\<日期>.jsonl` 出现该 taskId |
| 注入 | 发含历史关键词的 prompt | 会话 `.messages.json` 出现 `<memory version="1"` |
| MCP | 让 Cline 调 `mem_recall` | 返回历史片段 |
| 蒸馏 | `node src\cli\memctl.ts distill --dry-run --limit 1` | errors 0，有 tokens 统计 |
| 自动蒸馏 | `node src\cli\memctl.ts auto on --quiet 15` | 日志出现 `auto-distill:` 行 |
| 提醒 | `node src\cli\memctl.ts review --notify` | 有候选时弹 Windows 通知 |
| 删除 | `node src\cli\memctl.ts forget list` | 能查看删除名单 |

PreCompact 只在长会话压缩时触发，归档后 `node src\cli\memctl.ts archive` 可查到。

## 6. 发布打包流程（每个版本）

1. 改 `package.json` 的 `version`（如 0.3.1）。
2. 提交：`git add -A && git commit -m "..."`
3. 打包：macOS `bash scripts/package.sh`；Windows `powershell -File scripts\package.ps1`
4. 记录 `mem-v<版本>.zip.sha256`，随包一起分发。
5. 在干净 Windows 机器上重复第 3、4 节验收。
6. 验收通过后打 tag：`git tag v0.3.1 && git push --tags`（有远端时）。

## 7. 回滚与卸载

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall.ps1
```

删除计划任务与我们生成的 hook 文件，保留 `%USERPROFILE%\.llm-memory` 数据；
如需彻底清除，手动删除该目录（先备份）。

## 8. 故障排查速查

| 现象 | 处理 |
|---|---|
| `verify.ps1` 报 hooks missing | 重新运行 `install-hooks.ps1 -Force`，确认文档目录未被 OneDrive 改写 |
| 中文乱码 / JSON 解析失败 | 使用仓库自带 hook-runner；配置 JSON 必须无 BOM（脚本已处理） |
| MCP 未连接 | 检查 `cline_mcp_settings.json` 中 `mem.command` 的 node 绝对路径是否存在 |
| daemon 不运行 | `Get-ScheduledTask mem-daemon | Start-ScheduledTask`；查看 memd.out.log |
| nvm-windows 换版本后失效 | 重跑 `install-service.ps1` 与 `install-mcp.ps1` |
| PowerShell 脚本被策略拦截 | 所有安装命令加 `-ExecutionPolicy Bypass` |
