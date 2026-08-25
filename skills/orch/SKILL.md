---
description: Runs the published orch CLI to triage, implement, and optionally open a pull request for a coding task. Use when the user wants orch to do the work rather than editing in-session.
name: orch
---

# orch

Delegate software tasks to the published `orch` CLI. Do not reimplement the pipeline in-session.

## Prerequisite

`orch` must be on `PATH`. If it is missing, install it with `npm install -g @welluable/orch` and confirm `orch --help` works before continuing.

## Recursion guard

Never invoke `orch` when `ORCH_JOB_SLUG`, `ORCH_SEQ_DEPTH`, or `ORCH_FANOUT_DEPTH` is set. Those env vars mean this session is already an orch backend agent; running orch again would recurse. Do the assigned stage work in-session instead.

## How to run

Require `orch` on `PATH`, run the CLI, **wait** for exit, then report the job slug from `.orch/<slug>/`. Do not do the task in-session when orch is the right tool.

- Default: `orch "<task>"` (triage → quick-fix or the full pipeline).
- Read-only: `orch --ask "…"`. Follow-up: `orch --ask --from <slug> "…"`.
- In-place small edit: `orch --quick "…"`. Cannot combine `--quick` with `--pr`.
- PR path: `orch "…" --pr` (needs `gh` on PATH and authenticated).
- Background: `orch "…" --detach`, then `orch list`, `orch status`, `orch logs`, `orch pause`, `orch resume`, `orch stop`.
- Multi-unit: `--seq` / `--decompose` / `--fan-out` are mutually exclusive families (see `orch --help`).

## After the run

Wait for the process to exit. Then report the slug, outcome, and any PR URL. Job files live under `.orch/<slug>/`.
