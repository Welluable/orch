# orch

CLI orchestrator that runs a triage → research → plan → implement pipeline against a task, using Cursor Agent or Claude Code as the backend.

## Install

```bash
npm install -g @welluable/orch
```

Requires a local agent CLI on your `PATH`: `agent` (Cursor) or `claude` (Claude Code).

## Usage

```bash
orch run -t "fix the typo in the README"
orch run -f task.md --agent claude
orch run -t "add a --verbose flag" --agent cursor -v
```

```text
orch run (-t <text> | -f <path>) [--agent cursor|claude] [-v]
```

If both `-f` and `-t` are set, the file wins. At least one is required.

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```
