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
  `--agent cursor|claude|agn|opencode` — orch owns the pipeline, the agent CLI does
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
(the Cursor Agent CLI, command `agent`); `claude`, `agn`, and `opencode` are also
supported. Pin a default with `orch config --agent <name>` so you don't need
`--agent` on every run (local `.orch/config` overrides global
`~/.orch/config`; CLI `--agent` still wins). See [Requirements](#requirements)
for details.

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
| Publish | With `--pr`: pushes `orch/<slug>` and opens a pull request via `gh`. |

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
  pr.md                               # generated PR body (--pr only)
  run.json                            # job state (state, phase, pid, ...); written for every run
  orch.log                            # full stdout/stderr of the run; --detach only

<parent-of-repo>/<repo-name>-<slug>   # worktree
orch/<slug>                           # branch
```

`research` and `planner` run in your invocation directory and write to the
paths above. Implementer stages (test-writer, test-critic, code-writer,
test-runner) run inside the worktree instead. The worktree is never deleted
automatically — it's left in place after the run so you can inspect,
continue, or merge the work whenever you're ready. With `--pr`, orch also
writes `pr.md` and records `base` / `remote` / `pushedAt` / `prUrl` /
`prNumber` on `run.json`.

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
                    │ (cursor/claude/agn/   │
                    │  opencode)            │
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
| `--pr` | After a successful commit on the complex path, pushes `orch/<slug>` and opens a pull request with `gh`. | You want a PR instead of a local merge hint (required later for served jobs). |

For `--ask`, Cursor uses `--mode ask`, Claude uses `--permission-mode plan`,
`agn` is prompt-only best-effort (it has no dedicated read-only flag), and
OpenCode uses `--agent plan` with `edit`/`bash` denied via `OPENCODE_PERMISSION`.

`--detach` only controls backgrounding, not whether a job record exists —
every non-`--dry-run` invocation gets one. Combining `--detach` with
`--ask`, `--quick`, or `--dry-run` is rejected outright (non-zero exit)
because there's no way to background those modes, not because they'd lack a
job record. Multiple `--detach` runs can execute concurrently in the same
directory, each with its own slug.

### Pull requests

`orch "<task>" --pr` adds a publish phase after commit: push
`orch/<slug>` to `origin`, then open a PR with `gh` (or reuse an existing
open PR for that head). The PR title is the first line of the task; the
body is assembled mechanically into `.orch/<slug>/pr.md` from the task
text, `task.md`, and the files-changed rollup — no agent writes it.

`--base <branch>` names a remote branch (`main`, not `origin/main`). With
`--pr` it is both the worktree start point (`origin/<base>`) and the PR
base. Without `--pr`, `--base` alone still starts the worktree at
`origin/<base>`. When `--pr` is set and `--base` is omitted, orch resolves
the remote default via `origin/HEAD`.

`--pr` requires `gh` on `PATH` and authenticated (`gh auth status`); that
check runs before any job is created. It cannot be combined with `--ask`,
`--quick`, or `--dry-run`. Skips (still `done`): triage → quick-fix, or
nothing to commit. Failures (job `failed` at `phase: "publish"`, commit
kept): push rejected or `gh pr create` failed. The local `merge: git merge …`
hint is suppressed when a PR URL is reported.

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
- `--pr` — after a successful commit, push `orch/<slug>` and open a pull
  request with `gh`; requires `gh` on `PATH` and authenticated; rejects
  `--ask`/`--quick`/`--dry-run`. See [Pull requests](#pull-requests).
- `--base <branch>` — remote base branch for the worktree start point
  (`origin/<branch>`) and, with `--pr`, the pull request base; defaults to
  the remote's default branch when `--pr` is set without `--base`.
- `--max-rounds <n>` — max writer⇄critic and writer⇄runner iterations per
  implementer loop; defaults to `5`, ignored with `--ask` and `--quick`.
- `--fan-out` — decomposes the task into parallel workers coordinated by this
  process instead of running the single-worktree pipeline (see
  [Fan-out](#fan-out)); rejects `--ask`/`--quick`/`--dry-run`/`--seq`.
- `--seq` — decomposes into ordered units, merges each into `orch/<slug>`,
  then adjusts the near-term backlog (see
  [Sequential multi-unit (`--seq`)](#sequential-multi-unit---seq)); rejects
  `--fan-out`/`--ask`/`--quick`/`--dry-run`.
- `--max-workers <n>` — max number of parallel fan-out workers; defaults to
  `4`; only meaningful with `--fan-out`.
- `--max-units <n>` — max number of sequential units; defaults to `8`; only
  meaningful with `--seq`.
- `--max-concurrency <n>` — optional hard ceiling on in-flight fan-out workers
  at once; omit to let the coordinator choose (typically the current layer's
  size); only meaningful with `--fan-out`.
- `--agent <cursor|claude|agn|opencode>` — selects the backend for the whole pipeline;
  when omitted, uses local `.orch/config`, then global `~/.orch/config`, else
  `cursor`.
- `--notify` / `--no-notify` — enable or disable a desktop notification when a
  job reaches a terminal state (`done` / `failed` / `stopped` / `crashed`).
  Default is on; config key `notify` and these flags share precedence
  CLI > local > global > on. Dry-run never notifies.
- `-h, --help` — displays help for the command.

Config:

- `orch config` — prints the effective agent and notify settings and which
  file(s) contributed (local / global / default). Does not prompt.
- `orch config --agent <cursor|claude|agn|opencode> [--global|--local]` — writes the
  default agent. Bare `--agent` (and `--global`) write `~/.orch/config`;
  `--local` writes `<cwd>/.orch/config`. There is no `orch init`.
- `orch config --notify` / `--no-notify` `[--local|--global]` — set desktop
  notify on or off without wiping `agent` (keys merge on write).

Job-control subcommands (see [Headless runs](#headless-runs)):

- `orch list` — lists all runs tracked under `.orch/` in the current directory.
- `orch status [slug]` — shows full status for a run; defaults to the most
  recently started run.
- `orch pause <slug>` — requests a pause at the run's next stage-boundary
  checkpoint.
- `orch resume <slug>` — unpauses a paused/pausing run, or recovers a
  failed/stopped/crashed complex job at its unfinished stage (thin recover +
  reentry; see failure resume). Not the same as continue.
- `orch continue <slug> "new task"` — starts a new complex pipeline on a
  **done** run's existing worktree/branch (same slug). Carries prior outcome
  into research/plan. For crash recovery use `orch resume` instead. For fan-out
  workers that finished, continue the worker slug, then `orch --integrate <parent>`.
- `orch stop <slug>` — sends `SIGTERM` to a running job (or reconciles a dead
  one to `crashed`).
- `orch logs <slug> [-f]` — prints a run's `orch.log`; `-f` follows it until
  the job reaches a terminal state.
- `orch jobs clean` — deletes every run tracked under `.orch/` in the current
  directory, after a `y/N` confirmation prompt. Refuses (without prompting)
  if any job is still live (`running`/`pausing`/`paused` with an alive pid);
  run `orch stop <slug>` first, then clean.

Examples:

```bash
orch "fix the typo in the README" --agent claude
orch "fix the bug described in task.md" --agent cursor -v
orch "implement the local spec" --agent agn -v
orch "fix the typo in the README" --agent opencode
orch --ask "where is the CLI entrypoint?" --agent claude
orch --ask "where is package.json?" --agent opencode
orch --quick "fix the typo in the README" --agent claude
orch "implement the flag" --pr --agent claude
orch "implement the flag" --pr --base develop --agent claude
orch "noop" --dry-run --agent cursor
orch "noop" --dry-run --agent opencode
orch config
orch config --agent claude
orch config --agent agn --local
orch config --agent opencode
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
orch list                     # SLUG  ROLE  STATE  PHASE  AGENT  STARTED  DURATION  PID
orch status swift-lagoon-49ea # full record: state, phase, branch, worktree, exit code, ...
orch pause swift-lagoon-49ea  # request a pause at the next stage-boundary checkpoint
orch resume swift-lagoon-49ea # unpause, or recover failed/stopped/crashed
orch continue swift-lagoon-49ea "follow-up polish"  # new work on a done run
orch logs swift-lagoon-49ea -f # follow orch.log until the run finishes
orch stop swift-lagoon-49ea   # SIGTERM the run
orch jobs clean                # delete every tracked run under .orch/ (asks to confirm; refuses if live)
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

## Fan-out

`--fan-out` decomposes a complex task into independent workers that each run
the full pipeline (minus triage) in their own worktree, then hands the green
branches to a dedicated integration session:

```bash
orch "implement the billing module" --fan-out --agent claude
```

```text
triage: complex — fan-out requested
boundaries: partitionable into billing scaffold + 3 endpoint workers
decomposer: split into 4 workers (1 scaffold, 3 parallel)
schedule: concurrency 3

[01-scaffold rapid-fox-x7q2] done — commit b2c3d4e
[02-invoices merry-elk-r4b1] running
[03-charges  wise-owl-k1a8] running
[02-invoices merry-elk-r4b1] done — commit c3d4e5f
[04-webhooks quirky-cedar-p8w3] done — commit d4e5f60

overlaps: none
[integrate tidy-heron-m2p9] merged 3 branches, full suite passed
commit: e5f6071 on orch/wise-pine-e904
merge:  git merge orch/wise-pine-e904
```

The flow, in order:

1. **Triage** runs once, same as any run. If it routes to quick-fix, fan-out
   is skipped entirely — triage never opts into fan-out on its own.
2. **`boundaries`** (new agent) researches only how the work can be split —
   what can run in parallel, where the coarse boundaries are, whether shared
   scaffolding (types, registries, barrels) needs to land first — and writes
   `boundaries.md`. It never plans implementation steps.
3. **`decomposer`** (new agent) reads `boundaries.md` and the task and emits
   a worker list (or declines with a reason). orch validates the decomposition
   itself — worker count, ownership, dependency graph, layer overlap, at most
   one `scaffold` worker — and feeds validation failures back to the
   decomposer for up to two repair attempts before giving up.
4. **Decline path.** If the decomposer declines, or validation still fails
   after repairs, orch falls through to today's single-worktree pipeline
   (research → plan → worktree → test loop → code loop → commit) — no
   `fanout.json`, no workers scheduled.
5. **Scaffold first.** If one worker is marked `scaffold`, it runs alone to
   completion before anything else starts; its commit becomes the base SHA
   every other worker (and the integration session) branches from. A failed
   scaffold aborts the whole fan-out before any parallel worker spawns.
6. **Parallel workers.** Each remaining worker is a full, cold orch pipeline
   (research → plan → worktree → test loop → code loop → commit) running as
   its own detached process in its own `.orch/<worker-slug>/` directory and
   worktree — a sibling `orch` invocation, not in-process work. The
   coordinator chooses how many run at once (capped by `--max-concurrency`
   when set) based on the dependency layer currently in flight; a worker
   whose dependency failed is recorded `skipped` and never started.
7. **Integration.** Once every worker has settled, the coordinator detects
   file overlaps between the `done` workers and spawns a specialized
   integration session (`--integrate`, a hidden flag) that merges their
   branches in order, resolves any conflicts with a dedicated `integrator`
   agent, then runs a runner-first verify loop (test-runner first,
   code-writer only on failure) before committing to `orch/<parent-slug>`. If
   no worker reached `done`, integration is skipped and the run exits
   non-zero.

Artifacts, in addition to the coordinator's own `run.json`/`orch.log`:

```text
<invocation-cwd>/.orch/<parent-slug>/
  boundaries.md    # partitionability research only
  fanout.json      # decomposition + scheduling state

<invocation-cwd>/.orch/<worker-slug>/
  research.md, task.md, status.md, run.json, orch.log   # a normal run, per worker

<invocation-cwd>/.orch/<integration-slug>/
  integration.md   # merge log, overlaps, conflict repairs, final verdict
```

The coordinator never creates its own worktree and never runs the
implementer stages itself outside of the decline path — after decomposition
it is pure orchestration: spawn, poll, report. Exit code is `0` only when
every worker succeeded and integration committed; any worker failure forces a
non-zero exit even if integration still commits on the green subset.

`orch list` renders an indented job tree: top-level rows are jobs with no
`parent` (coordinators and ordinary runs), children indent two spaces under
their coordinator with a `ROLE` column (`coordinator` / `worker` /
`integrate` / `-`). `orch status <parent>` expands each child's
state/phase/branch in the same tree order; `orch status <child>` shows a
`parent:` line and does not list siblings. Default `orch status` (no slug)
still picks the most recent job and uses the parent-vs-child view as
appropriate. `orch logs <parent>` tails the coordinator log only.

Cascade control is parent → children only: `orch pause|resume|stop <parent>`
applies to the coordinator and every live child (pause reports how many
children were signaled). `orch pause|resume|stop <child>` is leaf-only — no
upward cascade. While a parent is paused, the coordinator stops spawning at
its schedule checkpoints and does not kill live children; on resume it
re-attaches to still-live workers and spawns only still-pending ones (never
re-decomposing or duplicating finished/live work). A paused leaf is waited
on without failing it or starting dependents; a stopped/crashed/failed leaf
is marked `failed` in `fanout.json`, its dependents are skipped, and the
schedule continues. `SIGINT`/`SIGHUP`/`SIGTERM` on the coordinator (and
`orch stop <parent>`) cascade a `SIGTERM` to every live child it recorded —
the same as [Headless runs](#headless-runs)'s interrupt handling, just
extended to the whole fan-out tree; worktrees and branches are never
removed automatically.

Depth is capped at 1: every worker and the integration session run with
`ORCH_FANOUT_DEPTH=1` set, and `--fan-out` is rejected outright when that
variable is already present — a worker or integration session never fans out
again.

## Sequential multi-unit (`--seq`)

Big features fail in one context window. orch splits them into units agents
can finish. `--fan-out` runs independent units in parallel; `--seq` runs
ordered units one-by-one, merging each into `orch/<slug>` before adjusting
the next.

| | `--fan-out` | `--seq` |
|---|---|---|
| Split reason | Parallel independence | Finishable unit size + order |
| Boundaries | Yes | **No** |
| Unit shape | Workers + `dependsOn` / `owns` / layers | **Flat ordered list** |
| Schedule | Parallel (layers / concurrency) | **Strictly one unit at a time** |
| Base SHA | One shared base for all workers | **Advances after each merge** |
| Integrate | One session at the end | **Merge + verify after every unit** |
| Replan | Frozen after decompose | **Hybrid adjust** after each merge |

```bash
orch "implement the billing module" --seq --agent claude
orch "implement X" --seq --max-units 6
```

```text
triage: complex — seq requested
decomposer: 5 units
[01-types …] done — merged into orch/wise-pine-e904
adjust: rewrote 02-api against tip; dropped 05-legacy-path
[02-api …] done — merged
[03-ui …] failed at code-loop / test-runner (round 3)
stopped: 2/5 merged; next: orch resume <unit-slug>
```

The flow, in order:

1. **Triage** runs once. If it routes to quick-fix, seq is skipped entirely —
   triage never opts into `--seq` on its own.
2. **`seq-decomposer`** (no boundaries agent) emits an ordered `units[]`
   backlog, or declines → today's single-worktree pipeline with no `seq.json`.
3. **Schedule** runs concurrency 1: spawn the first pending unit at the current
   tip → wait → on failure stop the chain → on success merge into
   `orch/<parent-slug>`, runner-first verify, advance tip, hybrid-adjust the
   next 1–2 pending units (or drop obsolete ones), continue.
4. **Continue / resume.** Fix a failed unit with `orch resume <unit-slug>`,
   then `orch --seq-continue <parent>` (or `orch resume <parent>` when paused).
   Use `orch continue <unit-slug>` only for new follow-up work on a done unit.
   Do not `orch continue` the coordinator.

`--max-units` (default `8`) caps both the initial backlog and adjust growth.
Unit children set `ORCH_SEQ_DEPTH=1` and `ORCH_FANOUT_DEPTH=1` so they cannot
nest `--seq` or `--fan-out`. Deliverable stays on `orch/<parent-slug>` until
you merge it yourself.

## Project structure

Complex runs create a run directory and a sibling worktree, reusing the
layout shown in [Artifacts and worktrees](#artifacts-and-worktrees):

```text
<invocation-cwd>/.orch/<slug>/
  research.md
  task.md
  status.md
  pr.md                               # --pr only
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
pkill -f 'opencode run' # --agent opencode
```

## Agent compatibility

| Backend | `--agent` value | Status | Notes |
| --- | --- | --- | --- |
| Cursor Agent CLI | `cursor` | Supported (builtin default) | Command `agent` on `PATH`. Override via `orch config` or `--agent`. |
| Claude Code CLI | `claude` | Supported | Command `claude` on `PATH`. |
| agn | `agn` | Supported | Requires `npm install -g @welluable/agn-cli` (`>= 0.0.12`) and `agn init`. |
| OpenCode CLI | `opencode` | Supported | Command `opencode` on `PATH` (`>= 1.17.18`). Install from https://opencode.ai; first-time setup: `opencode auth login`. Read-only/`--ask` uses `--agent plan` with edit/bash denied. |

## Requirements

- A modern Node.js runtime.
- One supported agent CLI on your `PATH`: `agent` (Cursor), `claude` (Claude
  Code), `agn`, or `opencode` (OpenCode `>= 1.17.18`).
- Git, for any run that isn't `--ask` or `--quick` (worktrees and commits
  need it).
- The GitHub CLI (`gh`) on `PATH` and authenticated, when using `--pr`.

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
