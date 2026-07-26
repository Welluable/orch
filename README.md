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
  run.json                            # job state (state, phase, pid, ...); written for every run
  orch.log                            # full stdout/stderr of the run; --detach only

<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

`research` and `planner` run in your invocation directory and write to the
paths above. Implementer stages (test-writer, test-critic, code-writer,
test-runner) run inside the worktree instead. The worktree is never deleted
automatically — it's left in place after the run so you can inspect,
continue, or merge the work whenever you're ready.

`run.json` is written for every invocation — default, `--quick`, `--ask`, and
`--detach` alike — so `orch list`/`status` always have something to show; see
[Headless runs](#headless-runs). `orch.log` is only written for `--detach`
runs, since foreground runs already stream their output to your terminal.

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
| `--detach` | Runs the pipeline in a background process and returns immediately, printing the run slug. Manage it with `orch list/status/pause/resume/stop/logs`. | You want to kick off a run and keep using your shell, or run several tasks concurrently. |

For `--ask`, Cursor uses `--mode ask`, Claude uses `--permission-mode plan`,
and `agn` is prompt-only best-effort (it has no dedicated read-only flag).

`--detach` only controls backgrounding, not whether a job record exists —
every non-`--dry-run` invocation gets one. Combining `--detach` with
`--ask`, `--quick`, or `--dry-run` is rejected outright (non-zero exit)
because there's no way to background those modes, not because they'd lack a
job record. Multiple `--detach` runs can execute concurrently in the same
directory, each with its own slug.

## CLI Reference

```text
Usage: orch [options] [command] <task...>
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
- `--detach` — runs the pipeline in the background and returns immediately,
  printing `started <slug> (pid <pid>)`; rejects `--ask`/`--quick`/`--dry-run`.
- `--max-rounds <n>` — max writer⇄critic and writer⇄runner iterations per
  implementer loop; defaults to `5`, ignored with `--ask` and `--quick`.
- `--agent <cursor|claude|agn>` — selects the backend for the whole pipeline;
  defaults to `cursor`.
- `-h, --help` — displays help for the command.

Job-control subcommands (see [Headless runs](#headless-runs)):

- `orch list` — lists all runs tracked under `.orch/` in the current directory.
- `orch status [slug]` — shows full status for a run; defaults to the most
  recently started run.
- `orch pause <slug>` — requests a pause at the run's next stage-boundary
  checkpoint.
- `orch resume <slug>` — resumes a paused (or pausing) run.
- `orch stop <slug>` — sends `SIGTERM` to a running job (or reconciles a dead
  one to `crashed`).
- `orch logs <slug> [-f]` — prints a run's `orch.log`; `-f` follows it until
  the job reaches a terminal state.
- `orch jobs clean` — deletes every run tracked under `.orch/` in the current
  directory, after a `y/N` confirmation prompt.

Examples:

```bash
orch "fix the typo in the README" --agent claude
orch "fix the bug described in task.md" --agent cursor -v
orch "implement the local spec" --agent agn -v
orch --ask "where is the CLI entrypoint?" --agent claude
orch --quick "fix the typo in the README" --agent claude
orch "noop" --dry-run --agent cursor
```

## Headless runs

`--detach` starts the full pipeline in a background process and returns your
shell immediately:

```bash
orch "implement the local spec" --agent claude --detach
# started swift-lagoon-49ea (pid 12345)
```

The parent process validates the agent binary and flag combination, eagerly
allocates `.orch/<slug>/`, writes an initial `run.json`, then re-invokes
itself (without `--detach`) as a detached child with `ORCH_JOB_SLUG` set; the
child runs the actual pipeline and keeps `run.json` up to date as it
progresses. Manage it with the subcommands below, all scoped to the current
directory's `.orch/`:

```bash
orch list                     # SLUG  STATE  PHASE  AGENT  STARTED  PID
orch status swift-lagoon-49ea # full record: state, phase, branch, worktree, exit code, ...
orch pause swift-lagoon-49ea  # request a pause at the next stage-boundary checkpoint
orch resume swift-lagoon-49ea # resume a paused/pausing run
orch logs swift-lagoon-49ea -f # follow orch.log until the run finishes
orch stop swift-lagoon-49ea   # SIGTERM the run
orch jobs clean                # delete every tracked run under .orch/ (asks to confirm)
```

Pausing is cooperative and happens at stage boundaries (before the first
agent stage, and after each individual agent invocation) — it is not an OS
suspend, and a pause requested mid-stage takes effect only once that stage's
agent finishes. This means pause is not atomic across a writer⇄critic or
writer⇄runner pair: e.g. pausing during `test-writer` still lets
`test-writer` finish before the run actually pauses, ahead of `test-critic`.

`--detach` is rejected outright when combined with `--ask`, `--quick`, or
`--dry-run` — those modes have nothing to background — but that's a
restriction on backgrounding, not on job records: every non-`--dry-run`
invocation gets a `run.json`, `--detach` or not. Multiple `--detach` runs can
execute concurrently against the same directory, each tracked under its own
slug.

## Project structure

Complex runs create a run directory and a sibling worktree, reusing the
layout shown in [Artifacts and worktrees](#artifacts-and-worktrees):

```text
<invocation-cwd>/.orch/<slug>/
  research.md
  task.md
  status.md
  run.json                            # written for every run
  orch.log                            # --detach only

<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

Default quick-fixes, `--quick`, and `--ask` runs still get a `.orch/<slug>/`
directory with a `run.json` job record (so `orch list`/`status` can see them),
but no `research.md`/`task.md`/`status.md`, no worktree, and no commits.

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
