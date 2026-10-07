# 数据模型与存储布局

## 目录

```text
~/.llm-memory/
  config.json         # 模型/自动蒸馏/embedding 配置（0600，永不导出）
  db/memory.db        # SQLite（WAL），全部派生物，可重建
  raw/hooks/          # 原始 hook 事件 JSONL（按天）
  raw/injections/     # 注入指标 spool（按天）
  blobs/<sha256>.txt  # >8KB 工具结果（内容寻址）
  archive/<session>/<ts>/   # PreCompact 归档（contextJson/contextRaw）
  archive/index.jsonl # 归档索引
  profiles/TASTE-vN.md + TASTE.md + .state.json
  logs/memd.out.log   # daemon 日志（Windows 计划任务 / MEM_LOG_FILE=1）
  exports/            # memctl export 默认输出目录
```

## 表

### hook_events

hook 原始事件索引。`dedupe_key` = 整行 sha256（幂等）。

```
id, dedupe_key UNIQUE, event, received_at, task_id, hook_ts,
workspace_root, payload_json
索引: task_id, event
```

### sessions

一次 Cline / Codex / 通用会话。

```
session_id PK, source, provider, model, cwd, workspace_root, status,
started_at, updated_at, prompt, title, tokens_in, tokens_out, cost,
messages_path, system_prompt, hook_task_id, correlation, raw_json
```

`hook_task_id` 是 hook 的 `conv_*` id；没有时为 NULL，由时间窗关联填充。

### turns

对话内容块（text / thinking / tool_use / tool_result）。

```
id PK, session_id, turn_index, block_index, role, display_role, kind,
text, text_seg, tool_name, tool_call_id, is_error, content_json
UNIQUE(session_id, turn_index, block_index)
```

- `text_seg`：CJK 单字空格分隔，供 `turns_fts_seg` 使用。
- `display_role='system'` 的行是我们自己注入的 hook_context，蒸馏时跳过。

### turns_fts / turns_fts_seg

FTS5 外部内容表，触发器自动同步：

- `turns_fts(text)`：unicode61，英文/整段匹配。
- `turns_fts_seg(text_seg)`：中文 bigram phrase 检索。

### tool_calls

```
id PK, session_id, turn_index, tool_call_id, tool_name, parameters_json,
result_text, success, duration_ms, source, blob_hash
UNIQUE(session_id, tool_call_id)
```

`blob_hash` 非空时 `result_text` 只是 2KB 预览 + `[blob <hash> size=…]`。

### session_cards

每会话一行，启发式 + LLM 摘要。

```
session_id PK, goal, goal_seg, outcome, outcome_seg, tools_json,
files_json, errors_json, summary, decisions_json, open_questions_json,
lessons_json, generated_by (heuristic|llm), generated_at
```

### memory_units

语义记忆单元。

```
id PK, type (taste|preference|decision|fact|procedure|pitfall),
statement, statement_seg, detail, detail_seg, scope, confidence,
status (candidate|active|rejected|retired|superseded),
evidence_json, source_session, created_at, updated_at,
use_count, pinned, positive_feedback, negative_feedback,
supersedes_id, superseded_by
索引: status, type
```

不变量：

- 只有 `status='active'` 会注入。
- `findSimilarUnit` 同时参考 `forget_list(unit-statement)`：被忘记的语句不会复活。
- 注入计数由 `injections.unit_ids_json` 反算到 `use_count`。

### unit_feedback

显式反馈审计：`id, unit_id, signal(useful|wrong), note, created_at`。

### skills

```
id PK, name UNIQUE, slug, description, body, status(draft|active|rejected|retired),
evidence_json, source_units_json, path, use_count, success_count, fail_count,
created_at, updated_at, activated_at
```

`activate` 写 `~/.cline/skills/<slug>/SKILL.md`（YAML frontmatter: name/description）。

### injections

注入指标：`dedupe_key UNIQUE, ts, task_id, session_id, sections_json,
unit_ids_json, cards, turns, chars`。

### embeddings

`turn_id PK, session_id, vector BLOB(float32), dims, model, created_at`。
换模型/维度需清空重建（见 `docs/embedding.md`）。

### blobs / distill_state / task_prefs / forget_list / meta

- `blobs`: `hash PK, size, path, created_at`
- `distill_state`: `session_id PK, distilled_at, model, units_created, status(done|error), error`
- `task_prefs`: `task_id PK, memory_enabled, capture_enabled, updated_at`
- `forget_list`: `(kind, value) PK`，kind ∈ `session | task | unit-statement`
- `meta`: 预留 KV

## 幂等键

| 数据 | 键 |
|---|---|
| hook 事件 | 整行 sha256 |
| 注入记录 | 整行 sha256 |
| turn | (session_id, turn_index, block_index) |
| tool_call | (session_id, tool_call_id) |
| 单元去重 | normalized statement（精确 + bigram 0.7/containment 0.75） |
| 会话 | session_id（重入先删后插） |

## 重建流程

```bash
# 1. 停 daemon（launchctl/systemctl/Task）
# 2. 备份并删除 DB
mv ~/.llm-memory/db/memory.db ~/.llm-memory/db/memory.db.bak
# 3. 重建（从 Cline sessions + raw hooks + Codex/generic 来源）
memctl import
# 4. 重新生成卡片、profile（units 需重新蒸馏或从 export 导入）
```

raw 文件与 Cline 会话目录不受影响；`memory_units`、`injections`、
`distill_state` 属于派生物，重建需要重新蒸馏或 `memctl import <export>`。

## 增长与保留

- 单会话 JSON 约 1–20KB；blob 按需增长。
- 注入记录每天几十条，量级可忽略。
- 建议每季度 `memctl export --out <dir>` 备份一次；raw 目录可直接打包。
