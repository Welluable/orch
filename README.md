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

## How it works

Quick fixes run in place: triage decides the request is a small, safe change and a
single `quick-fix` agent edits the current working tree directly. No artifacts or
worktree are created.

Complex tasks get one randomly named run directory under the directory where you
invoked `orch` (never the orch install directory):

```text
<invocation-cwd>/.orch/<slug>/
  research.md
  task.md
  status.md
```

`orch` also creates a persistent sibling git worktree and branch for the run:

```text
<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

`research` and `planner` run in your invocation directory and write to the exact
paths above. `orch` then creates the worktree and runs `test-writer` and
`code-writer` inside it, passing them the exact artifact paths back in the
invocation directory. The worktree is left in place after the run so you can
inspect or continue the work; it is never deleted automatically.

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```
