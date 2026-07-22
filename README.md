# orch

CLI orchestrator that runs a triage → research → plan → implement pipeline against a task, using Cursor Agent, Claude Code, or agn as the backend.

## Install

```bash
npm install -g @welluable/orch
```

Requires a local agent CLI on your `PATH`: `agent` (Cursor), `claude` (Claude Code), or `agn`.

To use the `agn` backend:

```bash
npm install -g @welluable/agn-cli
agn init
```

Requires `@welluable/agn-cli` version `0.0.12` or later.

## Usage

```bash
orch "fix the typo in the README"
orch "fix the bug described in task.md" --agent claude
orch "add a --verbose flag" --agent cursor -v
orch "implement the local spec" --agent agn -v
orch --ask "where is the CLI entrypoint?" --agent claude
orch "noop" --dry-run --agent cursor
```

```text
orch <task...> [--agent cursor|claude|agn] [-v] [--dry-run] [--ask] [--max-rounds <n>]
```

`--dry-run` checks that the selected agent CLI (`agent`, `claude`, or `agn`) is on your `PATH`, prints `cwd` / `agent` / `pass` or `fail`, and exits without running the pipeline.

`--ask` skips triage and every write pipeline. It spawns a single read-only agent in the current directory, prints its reply to stdout, and never creates `.orch/` artifacts, worktrees, or commits. Cursor uses `--mode ask`; Claude uses `--permission-mode plan`. With `--agent agn`, read-only is prompt-only (best-effort — agn has no CLI read-only flag).

Mention a file path in the task text and the agent will read it with its own tools.

## Interrupts

Ctrl+C (`SIGINT`), terminal hangup (`SIGHUP`), and `SIGTERM` reap every detached agent process group, then exit with the usual shell statuses (130 / 129 / 143). If orch is force-killed (`SIGKILL`), handlers never run and orphans may remain — clean up manually:

```bash
pkill -f 'agent -p'    # --agent cursor
pkill -f 'claude '     # --agent claude, adjust to local argv
pkill -f 'agn '        # --agent agn
```

## How it works

`--ask` is a separate path: no triage, no quick-fix, no research/plan/implement
loops. One read-only `ask` agent answers the question and orch prints the reply.

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
paths above. `orch` then creates the worktree and runs implementer loops inside
it — `test-writer` ⇄ `test-critic`, then `code-writer` ⇄ `test-runner` (up to
`--max-rounds`, default 5) — committing only after the runner passes. Artifact
paths point back at the invocation directory. The worktree is left in place
after the run so you can inspect or continue the work; it is never deleted
automatically.

After every stage finishes, `orch` prints a one-paragraph, natural-language
summary of what happened in that step, e.g. `[test-writer 1/5] summary: ...`
(round-suffixed for looped stages, matching the spinner name). Each agent is
asked to append this paragraph after its required final message/JSON/path, and
`orch` strips it out before parsing JSON, forwarding content to the next
stage, or writing to `status.md`, so none of those existing contracts change.
This summary output is unrelated to `-v/--verbose`, which streams the raw
agent thinking/tool-use deltas as the pipeline runs — the per-step summary
always prints, with or without `-v`.

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```
