# Hook Completeness Audit

## Goal

mem must save all trajectory data. The data includes user input, LLM output,
tool calls, MCP calls, and skill use. Trajectory data shows the user need. It
also shows the path that the LLM explored. mem must crystallize the best path.
mem must help the user and the LLM in later tasks.

## Method

1. Read the hook contract in the Cline 4.1.22 bundle.
2. Read the capture code in `src/hooks/`, `src/ingest/`, and `src/distill/`.
3. Run `memctl hooks`. This command checks the 9 hook files. It also checks the
   last fire time for each event.
4. Compare each trajectory type with the storage.

## Coverage matrix

| Trajectory | Status | Storage | Gap |
|---|---|---|---|
| User text | Covered | `hook_events`, `turns(kind=text)` | None |
| User attachments and images | Partial | raw hook payload keeps references | Image bytes are not copied to blobs. The session parser ignores image blocks. |
| LLM text | Covered | `turns(kind=text)` | None |
| LLM thinking | Covered | `turns(kind=thinking)` | The distill bundle uses a short form only. |
| Tool calls | Covered | `tool_calls` | None |
| Tool results | Covered | `tool_calls.result_text`, `blobs` for large results | None |
| Tool failures | Covered | `tool_calls.success`, `sessions.lifecycle=failed` | None |
| MCP calls | Covered | `tool_calls` (the tool name is the MCP tool name) | Server-side errors are saved only if Cline writes them. |
| Skill use | Partial | `tool_calls` for `use_skill` | Outcome tracking is manual. |
| Plan and Act mode | Partial | The prompt wrapper holds the mode | No structured mode field. |
| Approval and denial clicks | Missing | Not stored | Cline 4.x does not write these events to `messages.json`. mem cannot save data that the host does not write. |
| Checkpoints and file state | Partial | Tool parameters and results | Checkpoint objects are not copied. |
| Cancellation | Covered | `sessions.lifecycle=cancelled` | None |
| Unknown abort | Covered | `sessions.lifecycle=aborted_unknown` | None |
| Context compaction | Partial | `archive/` | The continuity card is not validated in a live long session. |
| Subagents | Partial | Normal session records | The VS Code hook set has no subagent events. Parent links are not stored. |
| Parallel tool calls | Partial | `tool_calls` | The duration merge uses order. Parallel calls can mis-map. |
| Remote host (SSH, container) | Missing | None | The installer targets the local machine only. |
| Multi-window use | Covered | Separate session and task ids | None |
| Hook health | Covered | `memctl hooks` | None |

## Findings

### P0: Data loss on common trajectories

1. **Attachments and images.** A user often sends images. The raw hook payload
   keeps a reference. The image bytes are not in the store. A later task cannot
   use them.
2. **UI decisions.** Tool approvals, denials, and mode switches are user
   choices. Cline 4.x does not write them to `messages.json`. mem cannot
   capture them today. Record this limit in the docs.
3. **Outcome-linked crystallization.** The distiller sees the trajectory now.
   But no score links a path to an outcome. A skill draft can come from a failed
   session.
4. **Subagent lifecycle.** A subagent has its own context. The VS Code hook set
   has no subagent events. Parent and child links are lost.

### P1: Partial data

5. **Checkpoint snapshots.** Tool results cover most file edits. Checkpoint
   objects give the full file state. mem does not copy them.
6. **Parallel tool correlation.** The duration merge pairs calls by order. Two
   parallel calls of the same tool can swap durations.
7. **Compaction injection.** The archive works. The continuity card must be
   tested in a real long session.

### P2: Environment and scope

8. **Remote hosts.** A Remote-SSH or dev-container session keeps the data on the
   remote host. The installer must run there.
9. **More sources.** A Claude Code adapter is not implemented.

## Goal check

### Part 1: Save all trajectory data

Status: strong, not complete.

Text, thinking, tool calls, tool results, MCP calls, failures, cancellations,
and unknown aborts are covered. Attachments, UI decisions, checkpoints,
subagents, and remote hosts have gaps.

### Part 2: Crystallize the best path

Status: weak.

The distiller now receives the tool trajectory. The session summary records
decisions and lessons. But mem does not score paths. mem does not compare two
paths with the same goal. Skill drafts do not require a successful outcome.

### Part 3: Help the user and the LLM

Status: good.

The hook injects a fixed memory block. MCP gives on-demand search. Skills give
on-demand procedures. Feedback and decay exist. Feedback is manual.

## Next actions

1. Run `memctl hooks` on each machine. Fix all `missing` and
   `not_executable` rows.
2. Add attachment and image capture. Store each file as a blob. Add the blob
   hash to the turn record.
3. Add path scoring. Use the lifecycle and the tool results. Do not draft a
   skill from a failed session without a warning.
4. Add parent and child session links for subagents.
5. Test the PreCompact continuity card in a real long session.

## Honest limits

- mem saves only the data that Cline writes or sends.
- A streamed answer without a disk write is not recoverable.
- A hook can fail. The daemon repairs gaps from the session files.
- A host limit is not a mem bug. Document it.
