# MCP 工具参考

## 注册

macOS / Linux：

```bash
bash scripts/install-mcp.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-mcp.ps1
```

写入 `~/.cline/data/settings/cline_mcp_settings.json`：

```json
"mem": {
  "command": "<node>",
  "args": ["<repo>/src/mcp/server.ts"],
  "disabled": false,
  "autoApprove": ["mem_recall", "mem_status"],
  "timeout": 60
}
```

server 是 stdio JSON-RPC（每行一条消息），不监听端口，不需要额外进程。
重启 VS Code 或切换 MCP server 后生效。

## 工具

| 工具 | 参数 | 返回 | 写操作 |
|---|---|---|---|
| `mem_recall` | `query`, `limit?`, `workspace?` | `<memory>` 块（历史 turns） | 否 |
| `mem_status` | – | `<memory_status>{json}</memory_status>` | 否 |
| `mem_remember` | `content`, `type?`, `detail?`, `scope?` | `<memory_unit id status="candidate"/>` | 写候选 |
| `mem_feedback` | `unit_id`, `signal(useful\|wrong)`, `note?` | `<feedback confidence status/>` | 调整置信度 |
| `mem_taste` | – | 当前 TASTE profile markdown | 否 |
| `mem_search_raw` | `query`, `limit?`, `offset?` | 分页文本行 | 否 |
| `mem_forget` | `session_id` 或 `unit_id`，`confirm=true` | 删除结果 | 破坏性 |

语义约定：

- `mem_remember` 只写候选，不激活；激活必须人工审核（`memctl units approve` 或 TUI）。
- `mem_feedback`：useful → confidence +0.05；wrong → −0.15，低于 0.2 自动降回候选。
- `mem_forget` 未带 `confirm=true` 时直接拒绝，不会删除任何数据。
- 模型通过 MCP 写入的内容带 `evidence: [{source:"mcp"}]`，便于追溯。

## 手动验证

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mem_status","arguments":{}}}' \
  | MEM_DB=~/.llm-memory/db/memory.db node src/mcp/server.ts
```

## 安全

- 只读工具可放进 `autoApprove`；`mem_remember`、`mem_feedback` 建议保留人工批准。
- `mem_forget` 需要模型显式传 `confirm=true`，并且应在用户明确要求时使用。
- MCP 进程以当前用户运行，可读整个 memory store；不要在共享机器上暴露该配置。
