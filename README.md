# mem

Personal LLM memory for Cline (VS Code). The system records conversations,
indexes them locally, and later retrieves and injects relevant context.

- macOS setup: `docs/operations.md`
- Windows setup: `docs/windows.md` (PowerShell hooks, Task Scheduler)

## Requirements

- Node.js 24 or later. Node 24 provides `node:sqlite` with FTS5 and runs
  TypeScript files directly. Phase 1 has no npm dependencies.

## Phase 1 CLI

```bash
MEM_DB=var/memory.db node src/cli/memctl.ts import
MEM_DB=var/memory.db node src/cli/memctl.ts status
MEM_DB=var/memory.db node src/cli/memctl.ts sessions
MEM_DB=var/memory.db node src/cli/memctl.ts search nonce
MEM_DB=var/memory.db node src/cli/memctl.ts tools 10
```

`MEM_DB` overrides the database path. The default is
`~/.llm-memory/db/memory.db`. `CLINE_DATA_DIR` overrides the Cline data root.

## Daemon

```bash
MEM_DB=var/memory.db node src/daemon/memd.ts
```

The daemon imports once at startup, then polls every 2 seconds for new hook
events and session files, and runs a full resync every 5 minutes. Polling is
used instead of `fs.watch` for stability across platforms and file systems.

## MCP server

```bash
bash scripts/install-mcp.sh
```

The script registers a `mem` MCP server in
`~/.cline/data/settings/cline_mcp_settings.json`. Cline gets two read-only
tools:

- `mem_recall` - full-text search over captured conversations
- `mem_status` - store statistics

## Injection hook

```bash
bash scripts/install-hook.sh
```

The script replaces `~/Documents/Cline/Hooks/UserPromptSubmit` with a small
shim that runs `src/hooks/user_prompt_submit.ts`. On each prompt the hook
searches the local store and returns a fixed-structure `<memory>` block as
`contextModification`. The block is empty when nothing matches.

## Auto-start (launchd)

```bash
bash scripts/install-launchd.sh
```

Installs and starts `com.shameless.mem.daemon`. Stop the manual daemon first.
Logs go to `~/.llm-memory/logs/`. Remove it with
`bash scripts/uninstall-launchd.sh`.

## Retrieval quality

- Segmented CJK index (`turns_fts_seg`): Chinese text is indexed per character
  and queried with character bigrams.
- Near-duplicate turns are removed from the injected block.
- At most two turns per session enter the block.
- Same-workspace turns rank before cross-workspace turns.
- Session cards summarize each task: goal, outcome, tools, files, and errors.

## Taste distillation

```bash
bash scripts/configure-model.sh          # writes ~/.llm-memory/config.json (0600)
node src/cli/memctl.ts distill --dry-run --limit 2
node src/cli/memctl.ts distill --limit 5
node src/cli/memctl.ts units list --status candidate
node src/cli/memctl.ts units approve <id>
node src/cli/memctl.ts units reject <id>
```

Distillation redacts secrets, sends one session bundle to the configured
model, and stores candidates only. Candidate units never reach the context.
Active units render in the `<taste>` and `<preferences>` sections.

## Auto distillation (opt-in)

```bash
node src/cli/memctl.ts auto status
node src/cli/memctl.ts auto on --quiet 15 --scan 5 --max 3
node src/cli/memctl.ts auto off
```

When enabled, the daemon distills a session after `quietMinutes` without
updates, checks every `scanMinutes`, and processes at most `maxPerCycle`
sessions per cycle. Changed sessions are re-distilled; duplicate candidates
are skipped. Candidates still require manual review.

The distiller also receives the current active units. It marks candidates as
`new`, `duplicate`, or `supersedes`. Duplicates are dropped. A `supersedes`
candidate stores the target id and, when approved, retires the old unit.

## Profile snapshots

```bash
node src/cli/memctl.ts profile          # print the current TASTE profile
node src/cli/memctl.ts profile write    # write a versioned snapshot
```

Snapshots live in `~/.llm-memory/profiles/` as `TASTE-vN.md` plus the latest
`TASTE.md`. Approving or rejecting a unit updates the profile automatically.

```bash
node src/cli/memctl.ts profile list
node src/cli/memctl.ts profile show 2
node src/cli/memctl.ts profile diff 1 2
```

## Operations

### TUI

```bash
memctl tui            # full app: dashboard, sessions, search, review, skills, tasks, metrics, config
memctl tui --review   # review-only TUI
```

Screens switch with `1-9` or `Tab`. Row navigation `j/k` (or arrows).
Actions per screen: `a` approve/activate, `r` reject/retire, `p/u` pin/unpin,
`e` edit, `f` forget, `o/x` skill outcome, `n` draft skill, `d` distill
session, `x/i/s` export/import/scan on Config, `m/c/i` task toggles. `/` starts
search input, `q` quits. Non-TTY environments print a text summary.

```bash
memctl metrics                        # injection and unit metrics
memctl review [--notify]              # pending candidates
memctl sources                        # cline / codex / generic adapters
memctl report                         # weekly quality report
memctl archive                        # recent PreCompact archives
memctl units edit <id> --statement "..."   # edit / merge / pin
memctl units merge <keepId> <mergeId>
memctl units pin <id>
memctl skills list | draft | approve <id>
memctl export --out <dir> [--raw]     # portable backup
memctl import <dir>
memctl card <sessionId>               # LLM session summary
memctl scan [--redact-raw --yes]      # secret scan
memctl off <taskId> | on <taskId>     # per-task memory switch
memctl capture-off <taskId>
memctl tasks
memctl forget session <id> --yes
memctl forget unit <id> --yes
bash scripts/install-precompact-hook.sh     # archive pre-compaction context
bash scripts/install-review-reminder.sh     # daily 10:00 notification
```

## Optional embedding search

Add an `embedding` block to `~/.llm-memory/config.json`, then:

```bash
node src/cli/memctl.ts embed --limit 200   # embed pending turns
node src/cli/memctl.ts semantic "query"    # cosine search
```

Embedding search is optional and off by default. The prompt hook keeps using
the fast FTS path. Generic sources can be added with a
`sources.genericJsonl.dir` config entry (one JSONL file per session, lines
`{"role":"user","content":"...","ts":"..."}`).

## Tests

```bash
npm test
```

The test ingests the Phase 0 fixtures into a temporary SQLite database and
checks events, sessions, turns, tool calls, correlation, and FTS search.

## Layout

```text
src/cli/        memctl commands
src/core/       paths and shared helpers
src/ingest/     hook and session ingest, correlation
src/store/      schema and database
phase0/         live hook validation kit
tests/          fixtures and tests
docs/           Phase 0 contract and report
```

## Status

- Phase 0: complete. See `docs/phase0-report.md`.
- v0.2: capture, daemon, MCP recall, injection, session cards, taste
  distillation, auto-distill, semantic dedupe/supersede, profile snapshots,
  injection metrics, review reminders, PreCompact archive.
- Operations runbook: `docs/operations.md`.
