# orch

CLI orchestrator that runs a triage → research → plan → implement pipeline against a task, using Cursor Agent or Claude Code as the backend.

## Install

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
```

Requires a local agent CLI on your `PATH`. Two backends are currently supported: `agent` (Cursor) and `claude` (Claude Code).

## Usage

```bash
node main.js run -t "fix the typo in the README"
node main.js run -f task.md --agent claude
node main.js run -t "add a --verbose flag" --agent cursor -v
```

```text
orch run -f <file> | -t <text> [--agent cursor|claude] [-v]
```

## Scripts

| Script | Command |
|--------|---------|
| `npm test` | `node --test "test/**/*.test.js"` |
| `npm run merge-branch` | Merge helper (`scripts/merge-branch.js`) |
