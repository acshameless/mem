# 功能总览（v0.4.0）

按「数据流」顺序列出已实现能力、对应命令与实现文件。所有功能均本地运行，
唯一的外部调用是可选蒸馏/embedding 模型。

## 1. 采集（Capture）

| 能力 | 说明 | 实现 |
|---|---|---|
| Cline hooks | 9 个事件（TaskStart/Resume/Cancel/Complete、PreToolUse/PostToolUse、UserPromptSubmit、Notification、PreCompact） | `src/hooks/*.ts` + `phase0/` shim |
| 原始落盘 | hook payload 原样写 `~/.llm-memory/raw/hooks/YYYY-MM-DD.jsonl` | `src/hooks/capture.ts` |
| 会话解析 | Cline 4.x `sessions/<id>/<id>.json` + `.messages.json` → sessions/turns/tool_calls | `src/ingest/sessions.ts` |
| 增量 daemon | 2s 轮询 hooks/sessions/injections，5 分钟全量对账 | `src/daemon/memd.ts` |
| 事件关联 | hook taskId ↔ Cline session_id（taskId 优先，其次时间窗 ±30s + workspace） | `src/ingest/correlate.ts` |
| 工具耗时 | PostToolUse `executionTimeMs/success` 合并进 tool_calls | `src/ingest/tool_durations.ts` |
| 大输出归档 | >8KB 工具结果写内容寻址 blob，DB 存 2KB 预览 + hash | `src/core/blobs.ts` |
| PreCompact 归档 | 压缩前复制 contextJson/contextRaw 到 `archive/<session>/<ts>/` | `src/hooks/pre_compact.ts` |
| 多来源 | Cline、Codex CLI（rollout JSONL）、通用 JSONL | `src/ingest/codex.ts`、`src/ingest/generic.ts` |

## 2. 存储与索引（Store）

- SQLite（WAL）+ FTS5，`~/.llm-memory/db/memory.db`。
- 中文分段索引：CJK 单字入索引、查询按 bigram phrase。
- 所有派生物可重建：raw 是事实源（见 `docs/data-model.md`）。
- 表结构 19 张 + 5 张 FTS（`docs/data-model.md` 有完整列定义）。

## 3. 检索与注入（Retrieve & Inject）

| 能力 | 说明 | 实现 |
|---|---|---|
| 分层检索 | 中文分段 FTS → unicode FTS → LIKE 兜底 | `src/core/recall.ts` |
| 排序 | 同 workspace 优先 → 相关性 → 时间倒序 | 同上 |
| 向量重排（可选） | `injection.useEmbeddings=true` 时 query embedding 重排，失败回退 | `src/core/rerank.ts` |
| 会话排除 | 当前 session 不入注入（taskId 或时间窗解析） | `src/hooks/user_prompt_submit.ts` |
| 固定结构 | `taste/preferences/pitfalls/project/facts/procedures/cards/past` + hint | 同上 |
| 预算与去重 | 默认 3000 字符；每会话 ≤2 条；80% bigram 去重 | 同上 |
| 任务开关 | `@nomem` / `@nomem-capture` / `memctl off|capture-off <taskId>` | `src/core/prefs.ts` |
| 自注入过滤 | displayRole=system 的 hook_context 不进蒸馏 | `src/distill/run.ts` |

## 4. 记忆质量（Memory quality）

| 能力 | 命令 | 实现 |
|---|---|---|
| 会话卡 | 启发式 goal/outcome/tools/files/errors | `src/ingest/cards.ts` |
| LLM 摘要 | summary / decisions / open questions / lessons | `src/distill/prompt.ts` |
| 蒸馏 | `memctl distill`（手动）、daemon 自动（静默窗口） | `src/distill/run.ts` |
| 语义去重 | 蒸馏时携带 active 单元，模型标注 duplicate/supersedes | 同上 |
| 审核 | `memctl units approve|reject|edit|merge|pin` | `src/core/units.ts` |
| 反馈 | `mem_feedback`（useful +0.05 / wrong −0.15，低于 0.2 降级） | 同上 |
| 衰减 | `memctl decay --days 14`，无注入使用则 −0.05 | 同上 |
| profile | `TASTE-vN.md` 版本化快照 + diff | `src/profile/build.ts`、`src/profile/diff.ts` |
| 技能结晶 | procedure/重复工具序列 → `SKILL.md` → `~/.cline/skills` | `src/skills/build.ts` |

## 5. 接口（Interfaces）

- **CLI**：28 个子命令（见 `docs/cli.md`）。
- **MCP**：7 个工具（见 `docs/mcp.md`）。
- **TUI**：9 屏交互（见 `docs/tui.md`）。
- **HTTP 无**：daemon 不监听端口；MCP 走 stdio，hook 直接调用 Node。

## 6. 隐私与数据主权

| 能力 | 命令 |
|---|---|
| 密钥扫描 | `memctl scan` |
| raw 重写脱敏 | `memctl scan --redact-raw --yes` |
| 会话/单元删除 | `memctl forget session <id> --yes`、`forget unit <id> --yes` |
| 反重摄入名单 | `forget_list`（session/task/unit-statement 三类） |
| 导出/导入 | `memctl export --out <dir> [--raw]`、`memctl import <dir>`（不含密钥） |

## 7. 部署与运维

- 一键部署：`install.sh`（macOS/Linux）、`install.ps1` / `install.cmd`（Windows）。
- Node 24 自动安装：Homebrew → 官方 tarball；Windows 用 winget。
- 服务：macOS launchd、Linux systemd user（daemon + 每日 review timer）、Windows 任务计划。
- 发布：GitHub Actions CI（三平台矩阵）+ tag 触发 Release（zip + sha256）。
- 指标：`memctl metrics`、`memctl report`；注入记录表 `injections`。

## 未实现 / 可选

- Claude Code 适配器（接口已就绪，`src/adapters/index.ts`）。
- 图形化界面（非 TUI）。
- 云端同步（设计上坚持本地优先；`export/import` 覆盖手动迁移）。
