# orch

CLI orchestrator that runs a triage → research → plan → implement pipeline against a task, using Cursor Agent or Claude Code as the backend.

## Install

```bash
npm install -g @welluable/orch
```

Requires a local agent CLI on your `PATH`: `agent` (Cursor) or `claude` (Claude Code).

## Usage

```bash
orch "fix the typo in the README"
orch "fix the bug described in task.md" --agent claude
orch "add a --verbose flag" --agent cursor -v
```

```text
orch <text...> [--agent cursor|claude] [-v]
```

Mention a file path in the task text and the agent will read it with its own tools.

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```
