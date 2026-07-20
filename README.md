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
orch "noop" --dry-run --agent cursor
```

```text
orch <task...> [--agent cursor|claude] [-v] [--dry-run]
```

`--dry-run` checks that the selected agent CLI (`agent` or `claude`) is on your `PATH`, prints `cwd` / `agent` / `pass` or `fail`, and exits without running the pipeline.

Mention a file path in the task text and the agent will read it with its own tools.

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```
