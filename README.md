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
node main.js "fix the typo in the README"
node main.js "fix the bug described in task.md" --agent claude
node main.js "add a --verbose flag" --agent cursor -v
```

```text
orch <text...> [--agent cursor|claude] [-v]
```

Mention a file path in the task text and the agent will read it with its own tools.
