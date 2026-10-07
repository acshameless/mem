# 开发指南

## 环境

- Node.js 24+。项目零依赖，直接运行 `.ts`；Node 类型剥离要求语法可擦除：
  不使用 enum / namespace / 参数属性。
- 测试：`npm test` 或 `node --test "tests/**/*.test.ts"`（39 项）。
- 本地运行不污染正式库：`MEM_DB=var/memory.db node src/cli/memctl.ts status`。

## 目录

```text
src/cli/memctl.ts      命令入口（28 个子命令）
src/daemon/memd.ts     常驻进程：轮询、对账、自动蒸馏
src/hooks/             Cline hook 实现（UserPromptSubmit/PreCompact/capture）
src/ingest/            hook/session/codex/generic/cards/注入指标解析
src/core/              配置、路径、检索、单元、偏好、忘记、导出、扫描、重排
src/distill/           蒸馏 prompt、provider、运行管线
src/embed/             embedding provider（local/google/vertex/openai）+ 预设
src/skills/            技能结晶与 SKILL.md 输出
src/profile/           TASTE 快照与 diff
src/tui/               9 屏 TUI
src/mcp/server.ts      MCP stdio server
scripts/               安装、打包、服务、平台脚本（含 windows/）
tests/                 node:test 测试与 fixtures
```

## 约定

- 导入写全扩展名（`./foo.ts`），ESM 严格模式。
- 不加运行时依赖；SQLite 用 `node:sqlite`，HTTP 用全局 `fetch`。
- 数据库迁移：新列同时写进 `schema.sql`（新库）与 `db.ts` 的
  `tryExec(ALTER …)`（旧库）；迁移必须容错，只读打开不能失败。
- 幂等优先：任何写路径都要有去重键（见 `docs/data-model.md`）。
- hook 永远 fail-open：异常时输出空 `contextModification`，绝不阻塞对话。

## 扩展：新增来源适配器

1. `src/ingest/<source>.ts`：解析源数据，写入 `sessions/turns/tool_calls`
   （先删同 session 再插，保证幂等；导入前查 `isForgotten`）。
2. `src/adapters/index.ts`：注册 `{ id, name, sessionsRoot }`。
3. `src/cli/memctl.ts`：在 `import` 流程调用你的 ingest。
4. `tests/<source>.test.ts`：用最小 fixture 验证 session/turns/FTS/幂等。

参考实现：`src/ingest/codex.ts`、`src/ingest/generic.ts`。

## 扩展：新增 embedding 供应商

1. `src/embed/embed.ts`：加分支（OpenAI 兼容直接复用 `embedOpenAi`）。
2. `src/embed/presets.ts`：加预设（baseUrl/model/dimensions）。
3. `src/core/config.ts`：必要时扩展 provider 联合类型与推断。
4. `tests/embed-<provider>.test.ts`：mock `fetch`，断言 URL/认证/taskType/
   响应解析，以及 `embedPendingTurns` + `semanticSearch` 闭环。

## 扩展：新增记忆类型

1. `src/distill/prompt.ts`：类型白名单加入新类型。
2. `src/hooks/user_prompt_submit.ts`：加渲染段落（固定顺序）。
3. `src/core/units.ts`：如需新的筛选/排序逻辑。
4. 文档：`docs/data-model.md` 与 `docs/features.md`。

## 测试与发布

```bash
npm test                          # 39 项，CI 使用相同命令
bash scripts/package.sh           # dist/mem-v<version>.zip + sha256
git tag v0.4.0 && git push origin v0.4.0
```

- CI：`.github/workflows/ci.yml`（ubuntu/macos/windows 矩阵）。
- Release：`.github/workflows/release.yml` 在 tag 上自动测试、打包、
  创建 GitHub Release 并附 zip + sha256。

## 排障入口

- `memctl status` / `memctl metrics` / `memctl report`
- `tail -20 ~/.llm-memory/logs/memd.out.log`
- `sqlite3 ~/.llm-memory/db/memory.db "pragma integrity_check;"`
