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

- **Triage respects small work.** A one-line typo fix doesn't get research,
  a planner, or a five-round loop — triage routes it straight to a
  `quick-fix` agent (in-place without `--pr`; in a worktree with `--pr`
  so a PR can still open).
- **Verify before you implement.** Tests or acceptance criteria are written
  and frozen before any implementation code exists, so "done" means "passes
  the check," not "the agent said so."
- **Isolated implementation.** Complex tasks run in a persistent sibling git
  worktree on a `<prefix>/<slug>` branch, so your working tree stays untouched
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
| Quick-fix | A single agent edits directly; without `--pr`, in the current tree (no artifacts/worktree). With `--pr`, in a fresh worktree, then commit + publish. |
| Research | Reads the codebase and invocation-directory context, writes `research.md`. |
| Plan | Turns research into a concrete task checklist, writes `task.md`. |
| Worktree | Creates a sibling git worktree and a `<prefix>/<slug>` branch for isolated implementation. |
| Test loop | `test-writer` ⇄ `test-critic` iterate until tests/acceptance criteria are frozen. |
| Code loop | `code-writer` ⇄ `test-runner` iterate until the runner passes. |
| Commit | Commits the passing state on the run's branch inside the worktree. |
| Publish | With `--pr`: pushes `<prefix>/<slug>` and opens a pull request via `gh`. |

`--ask`, `--quick`, and `--dry-run` are alternate entry paths that bypass some
or all of this table — see [Execution modes](#execution-modes).

### Triage and short paths

Triage looks at the task text and decides whether it's a small, safe change
or something that needs the full pipeline. Small changes route to a
`quick-fix` agent. Without `--pr`, that agent edits your current working
tree directly — no artifacts, no worktree. With `--pr`, orch still skips
research/planner/loops, but creates a worktree, runs quick-fix there,
commits, and publishes a PR. `--quick` forces the in-place direct-edit
path without asking triage first (and cannot be combined with `--pr`).
`--ask` is separate again: it skips triage entirely and every write
pipeline, spawning one read-only agent that answers your question and
prints the reply.

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
<prefix>/<slug>                       # branch
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
┌────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│   orch CLI │ ──► │ stages (triage,      │ ──► │  git worktree +         │
│ (Commander)│     │ research, plan,      │     │  <prefix>/<slug> branch │
│            │     │ test/code loops)     │     │  (implementation)       │
└────────────┘     └──────────┬───────────┘     └─────────────────────────┘
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
| `--pr` | Always create a worktree, commit, push `<prefix>/<slug>`, and open a PR with `gh` — including when triage routes to quick-fix (research/planner skipped on that path). | You want a PR instead of a local merge hint (required later for served jobs). |
| `--decompose` | Plan-only sequential split: research → seq-decomposer → write `seq.json` (`state: planned`) and exit. No worktrees or unit spawns. | You want a reviewable backlog before spending N worktrees. |
| `--seq --from <slug>` | Load a planned `seq.json` and run today's seq schedule loop (skips triage/research/decompose). | You approved a `--decompose` plan and want to implement it. |
| `--ask --from <slug>` | Same-session **read-only** follow-up against `.orch/<slug>/ask.json` (reuses the ask slug; required follow-up prompt). | Continue an earlier `--ask` thread without starting a new slug. |

For `--ask`, Cursor uses `--mode ask`, Claude uses `--permission-mode plan`,
`agn` is prompt-only best-effort (it has no dedicated read-only flag), and
OpenCode uses `--agent plan` with `edit`/`bash` denied via `OPENCODE_PERMISSION`.
`--ask --from` uses the same read-only agent path.

Three distinct “from / continue” mechanisms (do not conflate them):

| Mechanism | Purpose | Artifact |
| --- | --- | --- |
| `orch continue <slug> "new task"` | New **write** pipeline on a **done**, **failed**, **stopped**, or **crashed** worktree (same slug) | Prior run worktree / `run.json` |
| `orch --seq --from <slug>` | Run a planned seq backlog (no task prompt; from file) | `seq.json` |
| `orch --ask --from <slug> "…"` | Same-session **read-only** ask follow-up | `ask.json` |

`--detach` only controls backgrounding, not whether a job record exists —
every non-`--dry-run` invocation gets one. Combining `--detach` with
`--ask`, `--quick`, or `--dry-run` is rejected outright (non-zero exit)
because there's no way to background those modes, not because they'd lack a
job record. Multiple `--detach` runs can execute concurrently in the same
directory, each with its own slug.

### Pull requests

`orch "<task>" --pr` always ends with a worktree-based publish: push
`<prefix>/<slug>` to `origin`, then open a PR with `gh` (or reuse an existing
open PR for that head). When triage chooses quick-fix, orch still
creates the worktree and publishes — it only skips research, planner, and
the test/code loops. The PR title is the first line of the task; the
body is assembled mechanically into `.orch/<slug>/pr.md` from the task
text, `task.md` (when present), and the files-changed rollup — no agent
writes it.

`--base <branch>` names a remote branch (`main`, not `origin/main`). With
`--pr` it is both the worktree start point (`origin/<base>`) and the PR
base. Without `--pr`, `--base` alone still starts the worktree at
`origin/<base>`. When `--pr` is set and `--base` is omitted, orch resolves
the remote default via `origin/HEAD`.

`--pr` requires `gh` on `PATH` and authenticated (`gh auth status`); that
check runs before any job is created. It cannot be combined with `--ask`,
`--quick`, or `--dry-run`. Skip (still `done`): nothing to commit.
Failures (job `failed` at `phase: "publish"`, commit kept): push rejected
or `gh pr create` failed. The local `merge: git merge …` hint is
suppressed when a PR URL is reported.

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
  and exits (skips triage and all write pipelines). Pair with `--from <slug>`
  for a same-session follow-up via `ask.json`:
  `orch --ask --from <slug> "<follow-up>"`. Same incompatible flags as plain
  `--ask` apply to `--ask --from` (`--detach`, `--seq`, `--fan-out`);
  `--seq --from` still rejects `--ask`.
- `--quick` — skips triage, runs `quick-fix` directly in the current working
  tree; creates no artifacts, worktrees, or commits.
- `--detach` — runs the pipeline in the background and returns immediately,
  printing `started <slug> (pid <pid>)`; rejects `--ask`/`--quick`/`--dry-run`.
- `--pr` — always create a worktree, commit, push `<prefix>/<slug>`, and open a
  pull request with `gh` (including triage → quick-fix); requires `gh` on
  `PATH` and authenticated; rejects `--ask`/`--quick`/`--dry-run`. See
  [Pull requests](#pull-requests).
- `--base <branch>` — remote base branch for the worktree start point
  (`origin/<branch>`) and, with `--pr`, the pull request base; defaults to
  the remote's default branch when `--pr` is set without `--base`.
- `--max-rounds <n>` — max writer⇄critic and writer⇄runner iterations per
  implementer loop; defaults to `5`, ignored with `--ask` and `--quick`.
- `--fan-out` — decomposes the task into parallel workers coordinated by this
  process instead of running the single-worktree pipeline (see
  [Fan-out](#fan-out)); rejects `--ask`/`--quick`/`--dry-run`/`--seq`/`--decompose`.
- `--seq` — decomposes into ordered units, merges each into `<prefix>/<slug>`,
  then adjusts the near-term backlog (see
  [Sequential multi-unit (`--seq`)](#sequential-multi-unit---seq)); rejects
  `--fan-out`/`--ask`/`--quick`/`--dry-run`/`--decompose`. With `--from <slug>`,
  loads a planned backlog and skips triage/research/decompose.
- `--decompose` — plan-only sequential decomposition: research, write
  `seq.json` with `state: planned`, print `next: orch --seq --from <slug>`, and
  exit (see [Decompose (`--decompose`)](#decompose---decompose)); rejects
  `--seq`/`--fan-out`/`--ask`/`--quick`/`--dry-run`/`--from`. `--detach` is
  allowed. No worktree is created at plan time.
- `--from <slug>` — with `--seq` or `--ask`: load `seq.json` schedule or
  continue `ask.json` for `<slug>`. With `--seq`: run without re-decomposing;
  task comes from the file (no task prompt); rejects `--max-units` (frozen at
  plan time) and nesting depths. With `--ask`: same-session read-only
  follow-up (required prompt); reuses the ask slug. `--seq --from` still
  rejects `--ask`.
- `--max-workers <n>` — max number of parallel fan-out workers; defaults to
  `4`; only meaningful with `--fan-out`.
- `--max-units <n>` — max number of sequential units; defaults to `8`;
  meaningful with `--seq` or `--decompose`; rejected with `--seq --from`.
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

- `orch config` — prints the effective agent, notify, and branchPrefix settings
  and which file(s) contributed (local / global / default). Does not prompt.
- `orch config --agent <cursor|claude|agn|opencode> [--global|--local]` — writes the
  default agent. Bare `--agent` (and `--global`) write `~/.orch/config`;
  `--local` writes `<cwd>/.orch/config`. There is no `orch init`.
- `orch config --notify` / `--no-notify` `[--local|--global]` — set desktop
  notify on or off without wiping `agent` (keys merge on write).
- `orch config --branch-prefix <ns> [--global|--local]` — pin the git branch
  prefix (`<prefix>/<slug>`; default prefix `orch`). Bare `--branch-prefix`
  (and `--global`) write `~/.orch/config`; `--local` writes `<cwd>/.orch/config`.
  Restore the builtin with `--branch-prefix orch`. Keys merge on write (must
  not wipe `agent`/`notify`).

Job-control subcommands (see [Headless runs](#headless-runs)):

- `orch list` — lists all runs tracked under `.orch/` in the current directory.
- `orch status [slug]` — shows full status for a run; defaults to the most
  recently started run.
- `orch pause <slug>` — requests a pause at the run's next stage-boundary
  checkpoint.
- `orch resume <slug>` — unpauses a paused/pausing run, or recovers a
  failed/stopped/crashed complex job at its unfinished stage (thin recover +
  reentry; see failure resume). Not the same as continue. `--detach`
  backgrounds failure resume under the same slug.
- `orch continue <slug> "new task"` — starts a new complex pipeline on a
  **done**, **failed**, **stopped**, or **crashed** run's existing
  worktree/branch (same slug; no new worktree). Carries prior outcome
  (including failure phase/stage/round/error for failure terminals) into
  research/plan. Resume and continue serve different recovery needs on a
  failed/stopped/crashed run: `orch resume` re-enters the exact failed stage
  in place, while `orch continue` starts a fresh attempt from research with a
  new task prompt on the same worktree. For fan-out workers that finished,
  continue the worker slug, then `orch --integrate <parent>`. `--detach`
  backgrounds the continue under the same slug.
- `orch stop <slug>` — sends `SIGTERM` to a running job (or reconciles a dead
  one to `crashed`).
- `orch logs <slug> [-f]` — prints a run's `orch.log`; `-f` follows it until
  the job reaches a terminal state.
- `orch jobs clean` — deletes every run tracked under `.orch/` in the current
  directory, after a `y/N` confirmation prompt. Refuses (without prompting)
  if any job is still live (`running`/`pausing`/`paused` with an alive pid);
  run `orch stop <slug>` first, then clean.

Serve (see [Serve (home products + mobile UI)](#serve-home-products--mobile-ui)):

- `orch serve` — long-lived HTTP server against `$HOME/.orch/products/` with a
  bundled mobile UI. Default `--host 0.0.0.0 --port 7333`. **No auth.** Requires
  `gh auth login`. Served jobs always publish with `--pr`.

Examples:

```bash
orch "fix the typo in the README" --agent claude
orch "fix the bug described in task.md" --agent cursor -v
orch "implement the local spec" --agent agn -v
orch "fix the typo in the README" --agent opencode
orch --ask "where is the CLI entrypoint?" --agent claude
orch --ask --from <slug> "and how is triage wired?" --agent claude
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
orch config --branch-prefix long_running_session
orch config --branch-prefix long_running_session --local
orch config --branch-prefix orch
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
orch resume swift-lagoon-49ea --detach  # recover in the background under the same slug
orch continue swift-lagoon-49ea "follow-up polish"  # new work on a done run
orch continue swift-lagoon-49ea "follow-up polish" --detach  # same, backgrounded
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

## Serve (home products + mobile UI)

`orch serve` is a long-lived process that manages **products** (git checkouts
under `~/.orch/products/`), accepts jobs over HTTP, and ships a
mobile-responsive web UI so you can start and watch orch sessions from a phone.

```bash
gh auth login                  # required — products always use GitHub
orch serve                     # default: 0.0.0.0:7333, no auth
# open http://127.0.0.1:7333/ locally, or http://<machine-ip>:7333/ from a phone
```

**Layout.** Home is always the OS user directory (`$HOME`). Products live only
under `$HOME/.orch/products/<slug>/` with a `product.json` and a GitHub
`origin`. There is no path argument and no linking of folders elsewhere on disk.

**Creating products (UI or `POST /api/products`).**

- **Blank (`init`):** local `git init` plus **`gh repo create` (always
  private)** under the logged-in GitHub user (or `--github-owner` / per-request
  `owner`), then push `main`. There is no local-only blank product.
- **Clone:** `git clone <url>` into `$HOME/.orch/products/<slug>/`.

**Jobs.** Every served job runs detached in that product's cwd and **always**
enables `--pr` (publish). Create via UI or `POST /api/products/<product>/jobs`
with optional exclusive `mode`: `seq`, `fan-out`, or `decompose` (omit =
normal pipeline) — matching the product page radios Default / SEQ / Fan out /
Decompose. Plan-only `decompose` writes `seq.json` (`state: planned`) and
leaves the job `done`; GET job/list payloads include `job.seq` (state +
units) when that file exists. The UI shows status, PR URL, logs, files
changed, and Pause / Resume / Stop, plus Clean jobs on the product page
(wipes that product’s tracked runs; refuses while live). When
`job.seq.state === 'planned'`, the job page also shows the units backlog and a
**Start** control that `POST /api/jobs/<slug>/start` — same as
`orch --seq --from <slug>` (rejects live or non-planned with 409).
Continue-from-UI (write pipeline) is not available — use `orch continue` on
the CLI.

**Ask chat.** Per-product read-only Q&A (same family as CLI `--ask`), with
same-session multiturn via `ask.json`. Never enters the write jobs queue.

- `POST /api/products/<product>/ask` — start; body `{ "prompt": "…" }`
  (alias `question`); optional `agent` → `{ slug, answer, session }`
- `POST /api/products/<product>/ask/<slug>` — follow-up (same semantics as
  CLI `--ask --from`)
- `GET /api/products/<product>/ask/<slug>` — `{ slug, session, job }`

The UI Ask panel on each product page uses these routes for same-session
multiturn chat.

**Security.** There is **no authentication** in v1. The default bind is
`0.0.0.0` so phones on the same network can reach the UI. Startup prints a
loud warning: anyone who can reach the port can create private GitHub repos
and run agents. Trust your network / firewall; optionally put the host behind
Tailscale or bind `--host 127.0.0.1` if you do not need LAN access.

```bash
orch serve --help
orch serve --host 0.0.0.0 --port 7333
orch serve --github-owner my-org --agent claude
```

Useful flags: `--port`, `--host` (default `0.0.0.0`), `--concurrency` (default
`2`), `--max-queue` (default `64`), `--agent`, `--max-rounds`, `--base`,
`--github-owner`.

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
ordered units one-by-one, merging each into `<prefix>/<slug>` before adjusting
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
   `<prefix>/<parent-slug>`, runner-first verify, advance tip, hybrid-adjust the
   next 1–2 pending units (or drop obsolete ones), continue.
4. **Continue / resume.** Fix a failed unit with `orch resume <unit-slug>`,
   then `orch --seq-continue <parent>` (or `orch resume <parent>` when paused).
   Use `orch continue <unit-slug>` only for new follow-up work on a done unit.
   Do not `orch continue` the coordinator.

`--max-units` (default `8`) caps both the initial backlog and adjust growth.
Unit children set `ORCH_SEQ_DEPTH=1` and `ORCH_FANOUT_DEPTH=1` so they cannot
nest `--seq` or `--fan-out`. Deliverable stays on `<prefix>/<parent-slug>` until
you merge it yourself.

To plan first and implement later, use [`--decompose`](#decompose---decompose)
then `orch --seq --from <slug>`.

## Decompose (`--decompose`)

Plan-only peer to `--ask` / `--quick` for sequential work: research once, split
into an ordered backlog of **N ≥ 1** units, write `seq.json`, and exit. No
triage, no worktrees, no unit spawns, no merge/adjust. A later
`--seq --from <slug>` loads that backlog and runs the seq schedule loop.

```bash
orch "implement the billing module" --decompose
orch "fix the typo in README" --decompose --max-units 6
orch "…" --decompose --agent claude --detach
```

```text
research: mapped billing routes, models, and existing payment helpers
decomposer: 5 units

  01-types     Add billing types and shared enums
  02-api       Invoice create/list endpoints
  03-charges   Charge capture + webhook handlers
  04-ui        Billing settings page
  05-tests     End-to-end coverage for the happy path

wrote: .orch/wise-pine-e904/seq.json
next:  orch --seq --from wise-pine-e904
```

If there is no useful split, the decomposer returns **one** unit covering the
whole task (a normal backlog of length 1). Empty `units[]` is invalid; after
up to two repair rounds orch fails the job rather than inventing a unit.

`--max-units` (default `8`) caps the backlog. `--detach` is allowed. Job
`role` stays unset until `--seq --from` promotes the same slug to
`coordinator`. The coordinator worktree/`<prefix>/<slug>` branch is created at
**execute** time (`--from`), not during plan — tip may drift between plan and
run; v1 advances tip to current `HEAD` when starting from `planned`.

```bash
orch --seq --from wise-pine-e904
```

Do not pass a task prompt or `--max-units` with `--from` (task and cap are
frozen in `seq.json`). `--seq-continue` remains recovery-only and is not the
decompose handoff.

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
<prefix>/<slug>                       # branch
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
- The GitHub CLI (`gh`) on `PATH` and authenticated, when using `--pr` or
  `orch serve` (run `gh auth login` first). Serve always needs GitHub because
  products are private repos under `~/.orch/products/`.

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
