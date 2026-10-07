# 架构与内部机制

## 进程模型

```text
Cline (VS Code)
  │  hooks (stdin JSON → stdout JSON, 30s 超时)
  ▼
~/.llm-memory/raw/hooks/*.jsonl          ← 原始事件（永不改写，除非 forget/scan）
  │
  ▼
memd（launchd/systemd/Task Scheduler 常驻）
  ├─ 2s 轮询：hooks / sessions / injections 增量入库
  ├─ 5min：全量对账 + 会话卡 + 用量统计 + 工具耗时合并
  └─ scanMinutes：自动蒸馏（静默窗口过滤）
  │
  ▼
SQLite（WAL）：sessions / turns / cards / units / injections / …
  │
  ├─ MCP server（stdio）：mem_recall 等 7 个工具
  └─ UserPromptSubmit hook（独立进程）：
       检索 → 重排（可选）→ 渲染固定块 → contextModification
```

要点：hook 不依赖 daemon 存活；daemon 不在时 hook 仍可注入（读旧数据），
采集通过原始 JSONL 补齐。

## 关键时序（一次 prompt）

1. Cline 执行 `UserPromptSubmit` hook（`powershell -File` 或直接执行）。
2. hook 读 stdin，先做原始采集（除非 `@nomem-capture`/capture 关闭）。
3. 打开 DB（只读），解析当前 session：
   `hook_task_id == taskId`，否则时间窗 ±30s + workspace 最近者。
4. 检索：分段 FTS → unicode FTS → LIKE；同 workspace 加权。
5. 可选 embedding 重排（query purpose=RETRIEVAL_QUERY）。
6. 拉取 units（pinned/person 优先 + 相关性）、cards、turns。
7. 渲染固定结构块，预算裁剪、去重、每会话 ≤2 条。
8. 输出 `{"cancel":false,"contextModification":"<memory…>"}`，写注入指标 spool。
9. Cline 把块包进 `<hook_context source="RunStart">` 注入模型上下文。

## 一致性模型

- **事实源**：`raw/hooks/*.jsonl`、Cline `sessions/`、`raw/injections/`、`archive/`、`blobs/`。
- **可重建**：DB 全部表可由上述文件重建；`memctl import` 负责从 sessions/raw 重新导入。
- **幂等**：hook 事件按行 hash 去重；session 重入先删后插；cards/units 用 upsert。
- **迁移**：`openDb()` 内联迁移（ALTER + 容错 tryExec），只读打开不会失败。

## 失败模式与处理

| 失败 | 行为 |
|---|---|
| daemon 挂掉 | hook 照常注入旧数据；原始 JSONL 继续写；重启后增量补齐 |
| hook 超时/异常 | fail-open：输出空 `contextModification`，绝不阻塞对话 |
| 模型 API 失败 | 蒸馏记入 `distill_state.status='error'`，下轮重试；注入回退 FTS |
| DB 损坏 | `pragma integrity_check`；删 DB 后用 raw/sessions 重建 |
| 注入超预算 | 按段落顺序裁剪；单条超长截断 600 字符 |
| 记忆过时 | feedback 负反馈降权 + `memctl decay`；supersede 替换 |

## 安全边界

- 外部调用仅两类：蒸馏模型（发脱敏后的会话文本）与 embedding（发文本）。
  `redactSecrets` 在发送前执行；`config.json`（0600）不参与导出。
- raw 允许含密钥（本机 0700）；`memctl scan` 报告，`--redact-raw --yes` 重写。
- MCP `mem_forget` 要求 `confirm=true`，写 denylist 防重新摄入。

## 扩展点

| 想加什么 | 改哪里 |
|---|---|
| 新来源（Claude Code 等） | `src/adapters/index.ts` 注册 + `src/ingest/*` 实现解析 |
| 新 embedding 供应商 | `src/embed/embed.ts` 分支 + `src/embed/presets.ts` 预设 |
| 新记忆类型 | `src/store/schema.sql` + `src/distill/prompt.ts` 白名单 + 注入段落 |
| 新注入段落 | `src/hooks/user_prompt_submit.ts` renderMemoryBlock |
| 新 MCP 工具 | `src/mcp/server.ts` tools 数组 + handler |
