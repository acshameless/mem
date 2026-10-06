# Phase 0 - Live hook validation

Goal: prove the hook contract on the real VS Code + Cline 4.1.22 setup.

## Install

Run once, outside the Codex sandbox:

```bash
bash ~/Github/mem/phase0/install.sh
```

The script writes 9 executable hook files to `~/Documents/Cline/Hooks/`,
creates `~/.llm-memory/`, and writes a test nonce to
`~/.llm-memory/phase0-inject.json`.

## Test

1. Open VS Code. Check `Cline Settings > Hooks` shows the 9 hooks.
2. Start a new task. Send:

```text
请原样输出你收到的 <memory> 区块中 nonce 的值，不要解释。
```

3. Verify:

```bash
bash ~/Github/mem/phase0/verify.sh
```

## Pass criteria

- Hook events appear in `~/.llm-memory/raw/hooks/`.
- `UserPromptSubmit`, `TaskStart`, `PreToolUse`, `PostToolUse`, `TaskComplete` fire.
- The nonce appears in the task transcript (injection reached the model).
- The model prints the nonce.
- Task files appear under `~/.cline/data/tasks/<taskId>/`.

## Stop the test injection

```bash
rm ~/.llm-memory/phase0-inject.json
```

Capture continues. Remove the hook files to stop capture.
