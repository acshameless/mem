# mem 运维手册

## 系统结构

```
Cline hooks ──> ~/.llm-memory/raw/ ──> memd (launchd, 2s 轮询)
                                          │
                                          ├─ SQLite: sessions / turns / cards / units / injections
                                          ├─ 自动蒸馏（静默 15 分钟，默认关闭时手动）
                                          └─ MCP server (mem_recall / mem_status)

UserPromptSubmit hook ──> 检索 ──> 固定结构 <memory> 块 ──> 模型上下文
```

## 数据目录

```
~/.llm-memory/
  config.json          # 模型 key、自动蒸馏配置（0600）
  db/memory.db         # 派生数据库（可从 raw 重建）
  raw/hooks/           # 原始 hook 事件 JSONL
  raw/injections/      # 注入记录 JSONL
  archive/             # PreCompact 归档
  profiles/            # TASTE-vN.md + TASTE.md
  logs/                # memd.out.log / memd.err.log / review.log
```

## 日常命令

```bash
node src/cli/memctl.ts status       # 数据库统计
node src/cli/memctl.ts metrics      # 注入与记忆使用指标
node src/cli/memctl.ts review       # 待审核候选
node src/cli/memctl.ts units list --status candidate
node src/cli/memctl.ts units approve <id>
node src/cli/memctl.ts units reject <id>
node src/cli/memctl.ts distill --limit 5      # 手动蒸馏（跳过静默期）
node src/cli/memctl.ts profile write          # 生成 profile 快照
node src/cli/memctl.ts profile diff 1 2       # 版本差异
node src/cli/memctl.ts auto status            # 自动蒸馏状态
node src/cli/memctl.ts auto on --quiet 15     # 启用自动蒸馏
node src/cli/memctl.ts search <关键词>         # 检索历史
node src/cli/memctl.ts report                 # 质量周报（采纳率、注入）
node src/cli/memctl.ts archive                # 最近的 PreCompact 归档
node src/cli/memctl.ts sources                # 已注册来源
node src/cli/memctl.ts forget session <id>            # 预览删除计划
node src/cli/memctl.ts forget session <id> --yes      # 执行删除 + 防重摄入
node src/cli/memctl.ts forget unit <id> --yes         # 删除单条记忆
node src/cli/memctl.ts forget list                    # 删除名单
node src/cli/memctl.ts embed --limit 200              # 可选：向量化
node src/cli/memctl.ts semantic "query"               # 可选：余弦检索
```

## 服务管理

```bash
launchctl list | grep mem                                  # 查看服务
launchctl kickstart -k gui/$(id -u)/com.shameless.mem.daemon  # 重启 daemon（加载新代码）
tail -f ~/.llm-memory/logs/memd.out.log                    # 观察日志
bash scripts/install-launchd.sh                            # 安装/重装 daemon
bash scripts/install-review-reminder.sh                    # 安装每日 10:00 提醒
bash scripts/install-precompact-hook.sh                    # 安装压缩归档 hook
```

代码更新后：重跑对应 install 脚本（如 hook 有变化），并 kickstart daemon。

## 配置参考

`~/.llm-memory/config.json`：

```json
{
  "distill": {
    "provider": "deepseek",
    "baseUrl": "https://api.deepseek.com",
    "model": "deepseek-chat",
    "apiKey": "sk-...",
    "maxSessionsPerRun": 20,
    "maxCharsPerSession": 8000,
    "temperature": 0.2
  },
  "autoDistill": {
    "enabled": true,
    "quietMinutes": 15,
    "scanMinutes": 5,
    "maxSessionsPerCycle": 3,
    "reDistillOnChange": true
  }
}
```

修改后立即生效（daemon 每次扫描重新读取）；只有代码变化需要重启 daemon。

## 故障排查

| 现象 | 检查 |
|---|---|
| 注入块为空 | 是否真的没有匹配；`ls ~/Documents/Cline/Hooks/UserPromptSubmit` 是否存在且可执行 |
| hook 不触发 | Cline Settings > Hooks 是否列出；VS Code 是否重启过；文件是否 755 |
| 蒸馏报错 | `sqlite3 ~/.llm-memory/db/memory.db "select * from distill_state where status='error'"`；检查 key |
| 自动蒸馏无日志 | `auto status` 是否 enabled；会话是否满静默期；`tail memd.out.log` |
| daemon 不工作 | `launchctl print gui/$(id -u)/com.shameless.mem.daemon`；查看 memd.err.log |
| 数据库异常 | `pragma integrity_check`；raw 是事实源，删 db 后 `memctl import` 可重建（会丢失 units/injections 等派生物） |

## 数据安全

- `~/.llm-memory` 权限 0700，config 0600；raw 不做脱敏，派生物与注入做密钥脱敏。
- 蒸馏发送前先做密钥脱敏；发送范围为单会话 goal/outcome/turns。
- 生产 key 已轮换；不要把 key 写入仓库。

## 待办（下一阶段）

1. `mem_forget`：按会话/单元删除 raw + 派生 + 反重摄入名单（设计已定，未实现）。
2. PreCompact 实测：长会话触发后检查 `archive/index.jsonl`。
3. 向量检索：当前仅 FTS5 + 中文分段索引。
4. 多来源适配器：generic JSONL 已可用（`sources.genericJsonl.dir`），Cline 为内置来源。
5. 向量检索：`embedding` 配置 + `memctl embed / semantic`，默认关闭。

## 版本控制

仓库初始化（在终端执行，沙箱无法写 `.git`）：

```bash
cd ~/Github/mem
git init -b main
git config user.name "your-name"
git config user.email "your-email"
git add -A
git commit -m "feat: mem v0.2 - personal LLM memory for Cline"
```
