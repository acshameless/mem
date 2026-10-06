# Phase 0 Report - Live hook validation

Date: 2026-10-06

## Environment

- macOS, VS Code, Cline 4.1.22 (`saoudrizwan.claude-dev-4.1.22`)
- Provider: deepseek, model `deepseek-v4-flash`
- `hooksEnabled` = true in `~/.cline/data/globalState.json`
- Workspace for the test: Cline chat workspace
  (`/Users/shameless/.cline/data/workspaces/chat`)

## Procedure

1. Installed 9 global hooks to `~/Documents/Cline/Hooks/`.
2. Started one new Cline task with the Phase 0 prompt.
3. The UserPromptSubmit hook returned a `contextModification` block with a nonce.
4. Compared hook payloads, session files, and the model answer.

## Results

### 1. Hook delivery: PASS

Three events fired and were captured in
`~/.llm-memory/raw/hooks/2026-10-06.jsonl`:

| Event | Count |
|---|---|
| TaskStart | 1 |
| UserPromptSubmit | 1 |
| TaskComplete | 1 |

Each payload contained `clineVersion`, `hookName`, `timestamp`, `taskId`,
`workspaceRoots`, `userId`, `model`, and the event object.

### 2. Context injection: PASS

The conversation file contains the injected block as message index 1:

```text
role: user
displayRole: system
text: <hook_context source="RunStart">
      <memory version="1" phase="0"><hint>CLINE_MEM_PHASE0_OK nonce=B53F8DFCE6A0</hint></memory>
      </hook_context>
```

The assistant message contains the nonce in both its thinking and its text.
`TaskComplete.taskMetadata.result` is `B53F8DFCE6A0`.

Conclusion: `contextModification` reaches the model before the model call.

### 3. Session storage: FOUND

Cline 4.1.22 does not use the old `tasks/<taskId>/` layout.

- `~/.cline/data/sessions/<sessionId>/<sessionId>.json` - metadata
- `~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json` - messages and full system prompt
- `~/.cline/data/db/sessions.db` - session index

The `sessions.db` row:

| Field | Value |
|---|---|
| session_id | 1791294044196_5vc32 |
| source | vscode |
| provider | deepseek |
| model | deepseek-v4-flash |
| workspace_root | /Users/shameless/.cline/data/workspaces/chat |
| status | idle |

### 3b. Tool hooks: PASS (second task)

The second task used tools. Events captured (14 total in the fixture):

| Event | Count |
|---|---|
| TaskStart | 2 |
| UserPromptSubmit | 2 |
| PreToolUse | 4 |
| PostToolUse | 4 |
| TaskComplete | 2 |

Tool event details:

- Tool name: `run_commands`
- `parameters.commands` is a JSON-encoded string, not an object:
  `"[\"head -n 1 /Users/shameless/Github/mem/phase0/sample-prompt.txt\"]"`
- `postToolUse.result` is a string. `success` and `executionTimeMs` are present.
- Observed durations: 63 ms to 6952 ms.

### 3c. Injection control: PASS

After the marker file was removed, the second task contained no injected block
(`<memory version=` count = 0). The model also reported that it received no
memory block. This confirms the marker file controls Phase 0 injection.

### 3d. Project workspace: PASS (third task)

The third task ran with `~/Github/mem` open as the VS Code workspace.

- Hook `workspaceRoots`: `["/Users/shameless/Github/mem"]`
- Session `workspace_root` and `cwd`: `/Users/shameless/Github/mem`
- Session id: `1791295188490_6mnpx`
- Tools observed: `run_commands`, `read_files`

Totals across all three tasks: 21 hook events, 3 sessions, 34 turns, 6 tool calls.

### 4. Correlation caveat

The hook `taskId` is `conv_1791294044365_s6ipiqu`.
The session id is `1791294044196_5vc32`.
The conversation id is not persisted in any file.

Phase 1 must correlate hook events to session files by time window, prompt
hash, and workspace root. The hook stream remains the primary event log.

### 5. Hook model fields are unreliable

The hook payload reported `model.provider = "unknown"` and
`model.slug = "unknown"`. The session JSON reported the true provider and
model. Read model metadata from the session files, not from the hook payload.

## Open items before Phase 1

1. `PreCompact`, `Notification`, `TaskResume`, and `TaskCancel` are not yet exercised.
2. The FTS tokenizer is `unicode61`. CJK phrase search needs segmentation work in
   Phase 2 (for example a trigram index or a segmented search column).

## Artifacts

- Hook payload fixture: `tests/fixtures/phase0/hooks/2026-10-06.jsonl`
- Session fixture: `tests/fixtures/phase0/session/`
- Tool-using session fixture: `tests/fixtures/phase0/session-tools/`
- Contract: `docs/phase0-contract.md`
