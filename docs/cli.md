# memctl 命令参考

安装：`bash scripts/install-cli.sh`（npm link，或软链到 `~/.local/bin`）；
Windows：`scripts\windows\install-cli.ps1`（写入 `%USERPROFILE%\.mem\bin` 并加入 PATH）。
未安装时可等价使用 `node src/cli/memctl.ts <command>`。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `MEM_HOME` | 数据根目录 | `~/.llm-memory` |
| `MEM_DB` | 数据库路径（覆盖 MEM_HOME 推导） | `$MEM_HOME/db/memory.db` |
| `MEM_CONFIG` | 配置文件路径 | `$MEM_HOME/config.json` |
| `CLINE_DATA_DIR` | Cline 数据根 | `~/.cline/data` |
| `CODEX_SESSIONS_DIR` | Codex rollout 根 | `~/.codex/sessions` |
| `MEM_GENERIC_DIR` | 通用 JSONL 目录 | 无 |
| `CLINE_SKILLS_DIR` | 技能输出目录 | `~/.cline/skills` |
| `MEM_BLOCK_CHARS` | 注入预算（覆盖配置） | 3000 |
| `MEM_LOG_FILE` | 强制 daemon 写日志文件 | 仅 Windows 默认开 |

## 状态与采集

```bash
memctl status                 # 表计数、最新会话
memctl metrics                # 注入量、单元状态、top 使用单元、近 7 天
memctl report                 # 周报：采纳率、stale 单元
memctl sources                # cline / codex / generic-jsonl
memctl import                 # 全量/增量导入 hooks + sessions + codex + generic
memctl watch                  # 前台跑 daemon（等价 npm run memd）
memctl hooks [dir]            # 9 个 hook 的安装/可执行/最近触发检查
memctl paths [--rebuild]      # 轨迹分组、评分、最优路径（含步骤数）
memctl ui [--port 8787]       # 本地 Web UI（浏览器，跨平台）
```

## 会话与搜索

```bash
memctl sessions [limit]       # 最近会话
memctl card <sessionId>       # 会话卡（goal/outcome/summary/decisions/…）
memctl search <关键词>         # 中文分段 FTS，含 snippet
memctl tools [limit]          # 最近工具调用（耗时/成败）
memctl archive                # 最近 PreCompact 归档
```

## 蒸馏与审核

```bash
memctl distill --limit 5 [--session <id>] [--dry-run]
memctl units list [--status candidate|active|…] [--limit N]
memctl units approve <id> | reject <id> | pin <id> | unpin <id>
memctl units edit <id> [--statement …] [--detail …] [--scope …] [--type …]
memctl units merge <keepId> <mergeId>
memctl review [--notify]      # 候选清单；--notify 发系统通知
memctl decay [--days 14]      # 无使用记忆降权并刷新 profile
```

## Profile

```bash
memctl profile                # 打印当前 TASTE profile
memctl profile write          # 生成 TASTE-vN.md + TASTE.md
memctl profile list
memctl profile show <N>
memctl profile diff <A> <B>   # 行级 diff
```

## 技能

```bash
memctl skills list
memctl skills draft           # LLM 或启发式生成 SKILL.md 草稿
memctl skills approve <id>    # 写入 ~/.cline/skills/<slug>/SKILL.md
memctl skills reject <id> | retire <id>
memctl skills outcome <id> --success|--fail
```

## 任务开关

```bash
memctl off <taskId>           # 该 task 不再注入
memctl on <taskId>
memctl capture-off <taskId>   # 该 task 不再采集
memctl capture-on <taskId>
memctl tasks                  # 覆写列表
```

Prompt 内快捷方式：`@nomem`（停注入）、`@nomem-capture`（停采集）。

## 隐私与迁移

```bash
memctl scan                            # 扫描 raw/turns 中的密钥
memctl scan --redact-raw --yes         # 重写 raw JSONL 为 [REDACTED]
memctl forget session <id> [--include-active] --yes
memctl forget unit <id> --yes
memctl forget list
memctl export --out <dir> [--raw]      # JSONL + profiles + manifest，不含密钥
memctl import <dir>                    # 去重合并，可重复执行
```

## Embedding

```bash
memctl embedding preset local|lmstudio|google|vertex|openai
memctl embed --check                   # 验证端点，打印维度/耗时
memctl embed --limit 200               # 批量向量化待处理 turns
memctl semantic "查询"                  # 余弦检索
memctl llm preset local|deepseek|openai # 蒸馏模型预设（默认 local）
memctl llm model <name>                 # 切换本地模型名
memctl llm check                        # JSON 一致性 + 延迟体检
```

## 自动蒸馏

```bash
memctl auto status
memctl auto on [--quiet 15] [--scan 5] [--max 3]
memctl auto off
```

## TUI

```bash
memctl tui          # 9 屏应用
memctl tui --review # 仅审核
```

详见 `docs/tui.md`。

## 退出码

- `0`：成功。
- `1`：配置缺失（如未配置蒸馏 key）或运行失败。
- `2`：参数错误（usage）。
