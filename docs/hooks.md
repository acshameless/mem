# Hook 全覆盖、采集完整性与技能通道

## 一、9 个 hook：Cline 侧语义 + mem 侧动作

安装脚本写入全部 9 个 hook（macOS `~/Documents/Cline/Hooks/<事件>`，
Windows `<事件>.ps1`），每个都有处理逻辑，没有闲置项。

| Hook | Cline 侧语义（何时/输入/输出能力） | mem 做什么 | 影响模型 |
|---|---|---|---|
| `UserPromptSubmit` | 用户提交 prompt 后、组装 API 请求前调用。stdin: `{userPromptSubmit:{prompt,attachments},taskId,workspaceRoots,model,…}`；Cline 读取 stdout 的 `contextModification` 追加进上下文，`cancel=true` 可终止本轮 | 检索 units/cards/turns → 渲染固定块 → 返回 `contextModification`；同时原始采集 | **是**（唯一注入点） |
| `TaskStart` | 新任务创建时调用。stdin: `taskStart.taskMetadata{taskId,ulid,initialTask}`；与 UserPromptSubmit 同属“请求前”，支持注入 | 原始采集（taskId/workspace/model/初始任务） | 否 |
| `TaskResume` | 任务中断后恢复时调用。payload: `taskResume.taskMetadata{…}`；支持注入 | 原始采集 | 否 |
| `TaskCancel` | 任务被取消时调用。payload: `taskCancel`；本轮已结束 | 原始采集（生命周期收尾） | 否 |
| `TaskComplete` | 任务被判定完成时调用。stdin: `taskComplete.taskMetadata{taskId,ulid,result,command}`；本轮已结束 | 原始采集；daemon 据此刷新会话卡、启动静默蒸馏计时 | 否 |
| `PreToolUse` | 每次工具执行前调用。stdin: `preToolUse{toolName,parameters}`；`cancel=true` 可阻止该工具，支持 `contextModification` | 原始采集（工具名/参数），技能证据来源 | 否（可注入，刻意不用） |
| `PostToolUse` | 工具执行后调用。stdin: `postToolUse{toolName,parameters,result,success,executionTimeMs}`；Cline 允许 hook 覆写 result、支持注入 | 原始采集（结果/成败/耗时），合并进 `tool_calls` | 否（同上） |
| `PreCompact` | 上下文即将压缩前调用。stdin: `preCompact{contextSize,compactionStrategy,tokensIn/out,cache,deletedRange,contextJsonPath,contextRawPath}`；支持注入 | 归档 `contextJson/contextRaw`；可选注入 ≤400 字符 continuity card（默认关） | 可选（`injection.preCompact=true`） |
| `Notification` | Cline 到达用户注意边界/生命周期通知时调用。stdin: `notification{event,source,message,waitingForUserInput,severity,…}`；Cline 明确忽略 `cancel` 与 `contextModification`（observation-only） | 原始采集 | 否（Cline 侧忽略） |

为什么不注入更多 hook：

- `TaskStart/TaskResume` 与 `UserPromptSubmit` 同属请求前，首轮必有后者，重复注入无收益。
- `PreToolUse/PostToolUse` 在任务中途，注入会干扰当前计划；它们只贡献轨迹。
- `TaskComplete/TaskCancel` 时本轮已结束。
- `Notification` 被 Cline 定义为只读。

核心/CLI 运行时还有 Claude 风格事件（`SessionStart/End`、`Stop`、
`PostToolBatch`、`SubagentStart/Stop` 等），由 JSON hook 引擎驱动，不属于
VS Code 插件侧的 `<事件>.ps1` 发现机制；如未来暴露，采集层可直接扩展。

## 二、采集完整性：所有轨迹都要留下

设计原则：**用户输入、LLM 输出（含 tools / skills / MCP）、成功、失败、
未知中止，全部记录**。落地方式分三层：

| 轨迹 | 来源 | 存储 |
|---|---|---|
| 用户输入 | `UserPromptSubmit` hook + Cline 会话文件 | `hook_events` + `turns(kind=text)` |
| LLM 文本输出 | Cline 会话文件 `.messages.json` | `turns(kind=text)` |
| LLM 推理过程 | Cline 会话文件（thinking 块） | `turns(kind=thinking)` |
| 工具调用（含 `use_skill`、MCP 工具如 `mem_recall`） | 会话文件 tool_use/tool_result + Pre/PostToolUse hook | `tool_calls`（参数、结果、成败、耗时） |
| 技能加载与结果 | `use_skill` 工具调用 + 技能成效命令 | `tool_calls` + `skills.use_count/success_count/fail_count` |
| MCP 调用 | 会话文件 tool_use/tool_result（工具名即 MCP 工具） | `tool_calls` |
| 失败 | `PostToolUse.success=false`、`session.status=failed` | `tool_calls.success`、`sessions.lifecycle=failed` |
| 取消 | `TaskCancel` hook | `sessions.lifecycle=cancelled` |
| 未知原因中止 | `TaskStart` 后 10 分钟无完成/取消 | `sessions.lifecycle=aborted_unknown` |
| 上下文压缩 | `PreCompact` hook | `archive/<session>/<ts>/` + `archive/index.jsonl` |
| 大工具输出 | 会话文件 tool_result > 8KB | `blobs/<sha256>.txt` + `tool_calls.blob_hash` |

会话生命周期由 `src/ingest/lifecycle.ts` 推导，取值：
`completed / cancelled / failed / aborted_unknown / in_progress / idle`。
`memctl sessions`、`memctl metrics`、TUI Sessions 屏都会展示。

诚实的边界：

- Cline 未落盘的内容无法捕获（例如流式响应中途崩溃、进程被杀且未写文件）。
  这类情况以“最后落盘内容 + lifecycle 分类”为准，不伪造轨迹。
- hook 是 best-effort：漏事件由 daemon 的文件对账补齐（会话文件是事实源）。
- raw 是唯一事实源；DB 是派生层，可重建（见 `docs/data-model.md`）。

## 三、蒸馏如何使用轨迹

`src/distill/run.ts` 的 bundle 现在包含：

```text
SESSION / DATE / WORKSPACE / MODEL / TOOLS 汇总
TRAJECTORY（工具序列，含 use_skill 与 MCP 调用）
  [1] use_skill({"name":"deploy"}) -> ok in 120ms; result: skill loaded
  [2] mem_recall({"query":"部署"}) -> ok in 80ms; result: history rows
[USER] … [ASSISTANT] … [THINKING]（截断）
```

这样蒸馏模型能看到“怎么做成的/哪里失败的”，而不只是对话文本。
产物仍是 candidate，需要人工审核后激活。

## 四、三条进入模型的通道

```text
通道 1（自动背景，每次 prompt）
  UserPromptSubmit hook → contextModification → <hook_context><memory>…</memory>

通道 2（按需查询，模型主动）
  MCP server → 模型调用 mem_recall / mem_search_raw → tool_result

通道 3（按需技能，模型主动）
  ~/.cline/skills/<slug>/SKILL.md → Cline 扫描 → 模型调用 use_skill
```

分工：hook = 自动背景；MCP = 按需深挖历史；skills = 按需执行流程。

## 五、可选增强（未做）

1. `TaskStart` 会话简报（目前由 UserPromptSubmit 承担）。
2. `PreToolUse` 危险命令拦截（Cline 支持 `cancel`）与工具级即时提示。

## 六、契约校验（防 Cline 升级漂移）

```bash
memctl hooks --validate
```

- 扫描 `hook_events` 中的全部 payload，按 9 个事件的 schema 校验。
- 事件缺字段、类型错误、未知事件 → 逐条 `VIOLATION` 输出，退出码 1。
- golden fixtures：`tests/fixtures/contract/hook-events.jsonl`（每个事件一条真实形状）。
- 测试同时覆盖「删除任一必需字段必须报错」与输出契约（`shouldContinue` 必须被拒绝）。
- Cline 升级后先跑一次 `memctl hooks --validate`，可立刻发现 schema 漂移。

## 六、PreCompact 注入：设计与启用

默认关闭。开启方式：

```json
{ "injection": { "preCompact": true } }
```

行为：

- 归档照常执行（压缩前上下文始终进入 `archive/`）。
- 额外返回一个 ≤400 字符的 continuity card，内容为 pinned + 置信度最高的
  active 单元（`<memory version="1" source="precompact">`），用于覆盖
  “任务中途压缩、用户还没发新 prompt”的连续性缺口。
- watermark `source="precompact"` 便于在采集侧识别，避免自我摄入。

开启前建议验证（我们尚未在真实长会话上实测注入块的存活位置）：

1. 开 `injection.preCompact`，构造一次会触发压缩的长会话。
2. 压缩后检查该会话 `.messages.json`：注入块是否仍在上下文（而非落入
   `deletedRange`）。
3. 若存活：保持开启；若被删除：保持关闭——下一次 `UserPromptSubmit` 仍会
   重新注入完整记忆，功能不会缺失，只是任务中途存在窗口期。

PreToolUse 不注入的理由（除拦截场景外）：

- 模型已决定调用该工具，注入只能影响下一个回合；
- 工具调用高频，注入会累积上下文并干扰当前计划；
- 需要“工具级提示”时，应按严格策略实现（指定工具、≤200 字符、每任务一次、
  watermark 去重），而不是默认全量注入。
