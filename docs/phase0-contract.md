# Phase 0 hook contract (Cline 4.1.22, verified from the extension bundle)

## Discovery

- Global hooks: `~/Documents/Cline/Hooks/<EventName>`
- Workspace hooks: `<workspace>/.clinerules/hooks/<EventName>`
- On macOS/Linux the file has no extension and must be executable.
- Windows uses `<EventName>.ps1`.

## Events

`TaskStart`, `TaskResume`, `TaskCancel`, `TaskComplete`, `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Notification`, `PreCompact`.

## Input

One compact JSON object on stdin:

```json
{
  "clineVersion": "4.1.22",
  "hookName": "UserPromptSubmit",
  "timestamp": "1759000000000",
  "workspaceRoots": ["/path/to/workspace"],
  "userId": "...",
  "model": { "provider": "...", "slug": "..." },
  "taskId": "...",
  "userPromptSubmit": { "prompt": "...", "attachments": [] }
}
```

Event payloads:

- `TaskStart`: `taskStart.taskMetadata.{taskId,ulid,initialTask}`
- `TaskComplete`: `taskComplete.taskMetadata.{taskId,ulid,result,command}`
- `PreToolUse`: `preToolUse.{toolName,parameters}`
- `PostToolUse`: `postToolUse.{toolName,parameters,result,success,executionTimeMs}`
- `PreCompact`: `preCompact.{contextSize,compactionStrategy,tokensIn,tokensOut,contextJsonPath,contextRawPath,...}`
- `Notification`: observation only. `cancel` and `contextModification` are ignored.

## Output

One JSON object on stdout:

```json
{ "cancel": false, "contextModification": "...", "errorMessage": "" }
```

- `cancel: true` stops the run. The stop reason uses `errorMessage` or `contextModification`.
- `contextModification` becomes `appendContext`.
- The extension inserts it as a user-role message with `displayRole = "system"`.
- Limit: 50,000 characters. The extension truncates longer text.
- Timeout: 30 seconds.
- `shouldContinue` is removed. Use `cancel` instead.
- Exit code 0 without JSON is a no-op success. Non-zero exit with valid JSON still works but logs a warning.

## Enable switch

- Settings key: `hooksEnabled`.
- Default is true when the key is absent.
- Per-hook enable state on macOS/Linux is the executable bit.

## Storage (verified live on 2026-10-06)

- Cline 4.1.22 does not use the old `globalStorage/tasks/<taskId>/` layout.
- Session metadata: `~/.cline/data/sessions/<sessionId>/<sessionId>.json`
- Conversation: `~/.cline/data/sessions/<sessionId>/<sessionId>.messages.json`
- Session index: `~/.cline/data/db/sessions.db`
- The messages file contains `messages[]` and the full `system_prompt`.
- Injected context appears as a user-role message with `displayRole = "system"`:

```text
<hook_context source="RunStart">
<memory version="1" phase="0">...</memory>
</hook_context>
```

- The hook `taskId` (`conv_<epoch>_<suffix>`) differs from the session id
  (`<epoch>_<suffix>`). The conversation id is not persisted. Phase 1 must
  correlate by time window, prompt hash, and workspace root, or treat the hook
  stream as the primary event log.
- The hook `model` fields are `unknown` in the VS Code path. Read the real
  provider and model from the session JSON or `sessions.db`.

## Tool payload notes (verified live)

- Tool events use the 4.1.22 name `run_commands` (not `execute_command`).
- `parameters` values are strings. Arrays and objects arrive JSON-encoded,
  for example `{"commands":"[\"ls\"]"}`.
- `postToolUse.result` is a string. `postToolUse.success` and
  `postToolUse.executionTimeMs` are present.
