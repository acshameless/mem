# Manual acceptance checklist (real VS Code + Cline)

Use one machine. Use a test workspace. Do not use your daily task list.
Record the result for each step. Report a failure with the exact command and
the exact output.

## 0. Preconditions

- [ ] Node.js 24 or later: `node -v`
- [ ] VS Code with the Cline extension
- [ ] Repository installed: `cd ~/Github/mem && bash install.sh`
- [ ] Daemon runs: `memctl status` shows counts
- [ ] Hook health: `memctl hooks` shows `installed=yes` for 9 events.
      `warn_never_fired` is normal before the first event.

## 1. Install surface

- [ ] `Cline Settings > Hooks` shows 9 hooks.
- [ ] `Cline MCP Servers` shows `mem` connected.
- [ ] `memctl ui` prints `http://127.0.0.1:8787`. Open it. The page loads.
- [ ] `memctl tui` opens the 9-screen TUI. Press `q` to quit.

## 2. Basic turn

1. Start a new Cline task in the test workspace.
2. Send: `请用一句话说明项目用途。`
3. Check:
   - [ ] `memctl status` shows one new session.
   - [ ] The session file has `<hook_context source="RunStart">` when memory matched.
   - [ ] `memctl sessions` shows the session with `lifecycle`.

## 3. Attachment capture

1. Start a new task. Attach one image. Send: `描述这张图。`
2. Check:
   - [ ] `sqlite3 ~/.llm-memory/db/memory.db "select kind,mime,size from attachments order by id desc limit 3;"` shows an image row.
   - [ ] The blob file exists in `~/.llm-memory/blobs/`.

## 4. Tool trajectory and parallel calls

1. Send: `运行两条命令：ls 和 pwd，然后报告结果。`
2. Check:
   - [ ] `memctl tools 10` shows both calls with `duration_ms`.
   - [ ] The durations match the observed times. A swap is a failure.

## 5. MCP tools

1. Send: `用 mem_recall 搜索“部署”，再调用 mem_status。`
2. Check:
   - [ ] Cline shows two MCP tool calls.
   - [ ] The tool results contain memory rows or `count="0"`.
   - [ ] `memctl metrics` counts the injection.

## 6. Skill use

1. `memctl skills draft` and `memctl skills approve <id>`.
2. Start a task. Send a request that fits the skill.
3. Check:
   - [ ] Cline lists the skill.
   - [ ] The model calls `use_skill`.
   - [ ] `memctl tools 10` shows `use_skill`.
   - [ ] `memctl skills outcome <id> --success` records the result.

## 7. Per-task switches

- [ ] Send `@nomem 说明项目用途` in a new task. No `<memory>` block appears.
- [ ] `memctl off <taskId>` then send a prompt. No `<memory>` block appears.
- [ ] `memctl capture-off <taskId>` then send a prompt. The task has no new
      hook events for this task.

## 8. Cancel and unknown abort

- [ ] Start a long task. Press the Cline stop button.
      `memctl sessions` shows `lifecycle=cancelled` for that task.
- [ ] Start a task. Kill the VS Code window during the run. Wait 10 minutes.
      `memctl sessions` shows `lifecycle=aborted_unknown`.

## 9. Context compaction (live test)

1. Set `injection.preCompact: true` in `~/.llm-memory/config.json`.
2. Run a long task that fills the context and triggers compaction.
3. Check:
   - [ ] `memctl archive` lists one archive.
   - [ ] `~/.llm-memory/archive/<session>/<ts>/` contains context files.
   - [ ] After compaction, open the session `.messages.json`. Check the
         `<memory version="1" source="precompact">` block.
   - [ ] If the block is gone, set `injection.preCompact: false`. The next
         `UserPromptSubmit` still injects memory.

## 10. Distill, review, and inject a new memory

1. Send a task with a clear preference: `以后回答先给结论，再给细节。`
2. Run `memctl distill --limit 1`. Check the candidate list.
3. `memctl units approve <id>`.
4. Start a new task. Send a prompt.
5. Check:
   - [ ] The injected block has a new `<taste>` item.
   - [ ] `memctl profile` shows the item.

## 11. Paths and scores

- [ ] `memctl paths --rebuild` shows one row for the test goal.
- [ ] The best session is a completed session.
- [ ] The score of the failed session is lower.
- [ ] `memctl skills draft` uses the best path (name or body mentions it).

## 12. Portability and privacy

- [ ] `memctl export --out /tmp/mem-export` writes files. No API key is present.
- [ ] `memctl import /tmp/mem-export` into a second store adds the units.
- [ ] `memctl scan` reports no secret. A test secret in a raw file is a failure.
- [ ] `memctl forget session <id> --yes` deletes derived rows.
- [ ] The same session does not come back after `memctl import`.

## 13. Web UI and TUI actions

- [ ] In the Web UI, approve a candidate. The active list updates.
- [ ] In the Web UI, browse sessions, skills, and paths.
- [ ] In the TUI, press `4`, then `a`. The unit is active.
- [ ] In the TUI, press `6`, then `o`. The skill outcome count increases.

## 14. Windows parity

- [ ] `memctl hooks` shows 9 hooks with the `.ps1` suffix.
- [ ] `Get-ScheduledTask mem-daemon` shows `State=Running`.
- [ ] A Cline task creates hook events.
- [ ] `memctl ui` and `memctl tui` work in Windows Terminal.

## Result record

| Step | Pass | Fail | Note |
|---|---|---|---|
| 1 Install surface | | | |
| 2 Basic turn | | | |
| 3 Attachments | | | |
| 4 Tool trajectory | | | |
| 5 MCP tools | | | |
| 6 Skill use | | | |
| 7 Task switches | | | |
| 8 Cancel and abort | | | |
| 9 Compaction | | | |
| 10 Distill and inject | | | |
| 11 Paths and scores | | | |
| 12 Portability and privacy | | | |
| 13 UI actions | | | |
| 14 Windows parity | | | |
