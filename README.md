# orch

**The local multi-agent coding pipeline.**

A CLI that turns a task description into staged, verified, committed code —
without you babysitting a single long-lived agent session.

Long agent sessions tend to blur research, planning, and editing together in
one context, skip writing tests before implementation, and edit your working
tree directly while you watch. orch splits that into separate stages, each
run by a fresh agent process. Complex work gets its own sibling git worktree
and branch, tests or acceptance criteria are locked in before any
implementation code is written, and orch only commits once a test runner
actually passes. Small requests skip all of that ceremony and just get fixed
in place.

```text
You:  orch "add a --verbose flag that streams agent output to stderr"
orch: triage: complex — staging a worktree and test loop
orch: [test-writer 1/5] wrote 3 cases covering the new flag
orch: [code-writer 2/5] implemented the flag; tests pass
orch: commit: a1b2c3d on orch/verbose-flag-x7q2
```

## Why orch?

- **Triage respects small work.** A one-line typo fix doesn't get a worktree,
  a test-writer, or a five-round loop — triage routes it straight to a
  `quick-fix` agent editing your current tree.
- **Verify before you implement.** Tests or acceptance criteria are written
  and frozen before any implementation code exists, so "done" means "passes
  the check," not "the agent said so."
- **Isolated implementation.** Complex tasks run in a persistent sibling git
  worktree on an `orch/<slug>` branch, so your working tree stays untouched
  until you decide to merge.
- **Agent-agnostic backends.** Pick the CLI you already trust with
  `--agent cursor|claude|agn` — orch owns the pipeline, the agent CLI does
  the reading and writing.
- **Readable runs.** Every stage prints a one-paragraph natural-language
  summary of what it did; add `-v` if you also want the raw thinking/output
  deltas.
- **Escape hatches when you don't need the pipeline.** `--ask` for a
  read-only question, `--quick` for a direct edit — both skip triage and
  artifacts entirely.

## Quick Start

```bash
npm install -g @welluable/orch
```

Make sure an agent CLI is on your `PATH` — orch defaults to `--agent cursor`
(the Cursor Agent CLI, command `agent`); `claude` and `agn` are also
supported. See [Requirements](#requirements) for details.

```bash
orch "fix the typo in the README"
```

That one command triages the request, and — because it's small — fixes it
directly in your current directory. For anything larger, orch will stage a
worktree and walk through the phases below automatically.

## How it works

Every run starts at triage, which decides how much ceremony the task needs.
From there, either a short path or the full phase sequence runs.

### Phases

| Phase | What happens |
| --- | --- |
| Triage | Classifies the task as a quick fix or complex work needing the full pipeline. |
| Quick-fix | A single agent edits the current working tree directly; no artifacts, no worktree. |
| Research | Reads the codebase and invocation-directory context, writes `research.md`. |
| Plan | Turns research into a concrete task checklist, writes `task.md`. |
| Worktree | Creates a sibling git worktree and an `orch/<slug>` branch for isolated implementation. |
| Test loop | `test-writer` ⇄ `test-critic` iterate until tests/acceptance criteria are frozen. |
| Code loop | `code-writer` ⇄ `test-runner` iterate until the runner passes. |
| Commit | Commits the passing state on the run's branch inside the worktree. |

`--ask`, `--quick`, and `--dry-run` are alternate entry paths that bypass some
or all of this table — see [Execution modes](#execution-modes).

### Triage and short paths

Triage looks at the task text and decides whether it's a small, safe change
or something that needs the full pipeline. Small changes route to a
`quick-fix` agent that edits your current working tree directly — no
artifacts, no worktree, no fix plan. `--quick` forces this same direct-edit
path without asking triage first. `--ask` is separate again: it skips triage
entirely and every write pipeline, spawning one read-only agent that answers
your question and prints the reply.

### Verification loops

Once a run reaches the worktree, two writer⇄critic loops gate the work in
sequence:

```text
test-writer ──┐
              ├──⇄── test-critic  ──►  tests frozen
(iterate up to --max-rounds)

code-writer ──┐
              ├──⇄── test-runner  ──►  commit (on pass)
(iterate up to --max-rounds)
```

orch owns the retries and the pass/fail gating itself — each round runs in a
fresh agent process, so no stage inherits stale context from a previous
attempt. If a loop exhausts `--max-rounds` (default 5) without passing, orch
exits non-zero and leaves the worktree and `status.md` in place so you can
inspect exactly what was tried.

### Artifacts and worktrees

Complex tasks get one randomly named run directory under the directory where
you invoked `orch`, plus a persistent sibling git worktree and branch:

```text
<invocation-cwd>/.orch/<slug>/
  research.md
  task.md
  status.md

<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

`research` and `planner` run in your invocation directory and write to the
paths above. Implementer stages (test-writer, test-critic, code-writer,
test-runner) run inside the worktree instead. The worktree is never deleted
automatically — it's left in place after the run so you can inspect,
continue, or merge the work whenever you're ready.

## Architecture

```text
┌────────────┐     ┌──────────────────────┐     ┌────────────────────┐
│   orch CLI │ ──► │ stages (triage,      │ ──► │  git worktree +     │
│ (Commander)│     │ research, plan,      │     │  orch/<slug> branch │
│            │     │ test/code loops)     │     │  (implementation)   │
└────────────┘     └──────────┬───────────┘     └────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ agent backend adapter │
                    │ (cursor / claude / agn)│
                    └──────────────────────┘
```

orch owns the orchestration, staging, and pass/fail gating; the selected
agent CLI does all the actual reading and writing of files.

## Execution modes

| Mode | Behavior | Use when |
| --- | --- | --- |
| Default | Full triage → (quick-fix or research/plan/worktree/test-loop/code-loop/commit) pipeline. | You want orch to decide the right amount of ceremony. |
| `--quick` | Skips triage, runs `quick-fix` directly in the current tree; no artifacts, worktree, or commits. | You already know it's a small, direct edit. |
| `--ask` | Skips triage and all write pipelines; one read-only agent answers and orch prints the reply. | You want an answer about the codebase, not a change. |
| `--dry-run` | Checks the selected agent CLI is on `PATH` and exits without running the pipeline. | You want to sanity-check your setup before a real run. |

For `--ask`, Cursor uses `--mode ask`, Claude uses `--permission-mode plan`,
and `agn` is prompt-only best-effort (it has no dedicated read-only flag).

## CLI Reference

```text
Usage: orch [options] <task...>
```

- `<task...>` — task description to use as the prompt (mention a file path
  and the agent will read it with its own tools).
- `-V, --version` — outputs the version number.
- `-v, --verbose` — streams agent thinking/output deltas to stderr as the
  pipeline runs.
- `--dry-run` — checks that the selected agent CLI is on `PATH` and exits
  without running the pipeline.
- `--ask` — asks a read-only question about the codebase; prints the reply
  and exits (skips triage and all write pipelines).
- `--quick` — skips triage, runs `quick-fix` directly in the current working
  tree; creates no artifacts, worktrees, or commits.
- `--max-rounds <n>` — max writer⇄critic and writer⇄runner iterations per
  implementer loop; defaults to `5`, ignored with `--ask` and `--quick`.
- `--agent <cursor|claude|agn>` — selects the backend for the whole pipeline;
  defaults to `cursor`.
- `-h, --help` — displays help for the command.

Examples:

```bash
orch "fix the typo in the README" --agent claude
orch "fix the bug described in task.md" --agent cursor -v
orch "implement the local spec" --agent agn -v
orch --ask "where is the CLI entrypoint?" --agent claude
orch --quick "fix the typo in the README" --agent claude
orch "noop" --dry-run --agent cursor
```

## Project structure

Complex runs create a run directory and a sibling worktree, reusing the
layout shown in [Artifacts and worktrees](#artifacts-and-worktrees):

```text
<invocation-cwd>/.orch/<slug>/
  research.md
  task.md
  status.md

<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

Default quick fixes, `--quick`, and `--ask` runs create none of this — no
`.orch/` directory, no worktree, and no commits.

## Interrupts

`SIGINT`, `SIGHUP`, and `SIGTERM` reap every detached agent process group and
exit with the usual shell statuses (130 / 129 / 143). `SIGKILL` skips signal
handlers entirely and can leave orphaned agent processes behind — clean up
manually if that happens:

```bash
pkill -f 'agent -p'    # --agent cursor
pkill -f 'claude '     # --agent claude, adjust to local argv
pkill -f 'agn '        # --agent agn
```

## Agent compatibility

| Backend | `--agent` value | Status | Notes |
| --- | --- | --- | --- |
| Cursor Agent CLI | `cursor` | Supported (default) | Command `agent` on `PATH`. |
| Claude Code CLI | `claude` | Supported | Command `claude` on `PATH`. |
| agn | `agn` | Supported | Requires `npm install -g @welluable/agn-cli` (`>= 0.0.12`) and `agn init`. |

## Requirements

- A modern Node.js runtime.
- One supported agent CLI on your `PATH`: `agent` (Cursor), `claude` (Claude
  Code), or `agn`.
- Git, for any run that isn't `--ask` or `--quick` (worktrees and commits
  need it).

## Development

```bash
git clone git@github.com:Welluable/orch.git
cd orch
npm install
npm link          # optional: orch on PATH from this checkout
npm test
```

`npm run docs` re-runs orch itself in `--quick` mode to keep this README and
`orch --help` in sync with the current CLI.

## License

ISC
