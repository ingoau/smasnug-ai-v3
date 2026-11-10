# Traces and evals

The goal: find where the bot goes wrong or wastes effort in real conversations, and turn that into small changes to
the system prompt, skills and tool descriptions. Three layers:

1. **Traces** (always on): what each model loop saw and did.
2. **Detectors** (cheap, no model calls): score every finished turn and pick the ones worth a look.
3. **Analysis** (a coding agent such as Claude Code, run by hand): read the picked turns next to the repo, find
   patterns, and propose edits.

## Traces

`src/agent/trace.ts`. The front turn loop (`src/agent/front.ts`) and subagent runs (`src/agent/child.ts`) feed every
stream part to a `TraceRecorder`, plus the notes they add between steps (lookup-guard nudges, inbox messages,
orchestrator updates, background search results). At the end they `saveTrace`:

| column | |
|---|---|
| `kind`, `turn_id`, `run_id` | `front` (a turn) or `run` (a subagent run, with the turn that spawned it) |
| `model`, `prompt_hash`, `git_sha` | the model, the system prompt version (`prompt_versions` holds each text once), the code |
| `input` | the messages the loop started from: the turn message (thread context etc.) or the run's instructions |
| `steps` | per step: injected notes, text, reasoning, tool calls (input, clipped result or error, ms), usage, latency |
| `outcome`, `error` | `done` / `stopped` / `error` / `cancelled` / `timeout` |

Values are clipped (`TRACE_CLIP`) and binary data (images in tool results) is dropped. Saving is best-effort and never
blocks or fails a turn.

Each trace has a size budget (`TRACE_CLIP.total`), and strings are made safe for jsonb (no NUL, no lone surrogates).
`steps[].model` is the model that actually answered (`chatModel` may fall back to another provider).

Retention (`src/features/retention.ts`): traces cascade with their thread and go after the retention window (30
days). When a message is deleted in Slack, every trace in its channel that ran after the message was posted goes at
once (`applyDelete`; the turn input holds channel context, not just the thread). A trace still in flight is checked
when saved (`messages.deleted_at`), and the daily pass catches stragglers. A copy inside a tool result from another
channel (search, read_channel) only goes with the window. Unreferenced prompt versions go after the window too.
`PRIVACY.md` describes all this to users.

## Detectors

`src/eval/detectors.ts`, pure functions over a turn bundle (`src/eval/types.ts`, loaded by `src/eval/load.ts`). Each
flag has a weight; a turn's score is their sum.

| flag | signal |
|---|---|
| `turn_error`, `stopped`, `fallback_reply`, `reply_dropped` | the turn failed, was `!stop`ped, or ended with the generic / plain-text fallback |
| `user_correction` | the author's next message within 15 min reads as a correction or re-ask ("no, I meant…") |
| `negative_reaction` | 👎 / ❌ / 😕 … on a bot message posted during the turn |
| `plain_text`, `discarded_text` | the model answered in plain text instead of a tool / wrote text nobody sees |
| `lookup_guard`, `many_steps`, `token_heavy` | too much research in the front turn (should it have delegated?) |
| `repeated_call`, `tool_errors` | identical calls repeated (front or subagent), tools that failed |
| `skill_late`, `skill_reloaded` | `load_skill` only after a few steps / the same skill twice |
| `slow_turn`, `slow_first_text` | latency outliers (from `turn_timing`) |
| `run_failed`, `run_heavy`, `run_long` | subagent runs that errored, used many tokens or many steps |
| `self_reported`, `review_reported` | a failure report about the turn: the bot's own `report_failure`, or the background review (below) |

Turns from before tracing still get the event-based flags (`turn_tools`, `turn_timing`, `run_step` …); the
trace-based ones need traces. Thresholds are in `THRESHOLDS`.

## Failure reports

`failure_reports` (`src/features/failures/`) says *why* a turn went wrong, in fixed categories (`categories.ts`:
`gate_false_negative`, `gate_false_positive`, `incorrect_info`, `incomplete`, `misunderstood_request`,
`false_action_claim`, `wrong_action`, `missed_context`, `tool_failure`, `format_or_tone`, `too_slow`,
`capability_gap`, `other`). Two sources:

- **self**: the front agent's `report_failure` tool, when someone complains, corrects or re-asks, or it finds its own
  mistake. Invisible in the thread, one per turn, a few per thread per day. Evidence defaults to the triggering message.
- **review**: `features:failure-review` (every 10 min, `review.ts`) looks at threads idle for 30 min (up to 3 days
  old) once per new activity, like memory extraction. Only threads with a warning sign get a model call: a detector flag
  that a person saw (`WARNING_FLAGS`), a self report, a gate "no" whose author posted again within 30 min or a near miss
  (p ≥ 0.5); plus `failureReviewSampleRate` (10%) of the rest, and at most `failureReviewPerDay` calls per UTC day. The
  reviewer sees the transcript with the gate decision on each gated message, the flags and the self reports; it
  returns findings that cite transcript lines (uncited ones are dropped, a gate category needs a matching gate
  decision among them, and on a re-review a finding must cite a message newer than the last review; earlier review
  findings are in the prompt and keyed by anchor message + categories, so none is filed twice) and confirms or disputes each self report (`review_verdict`). Quotes come from our stored copy,
  never from the model. It never posts.

Each report also appends a `failure_report` event (categories only, no text) so the detectors see it; a disputed self
report gets a `failure_verdict` event and stops counting. Reports are
deleted with the thread, after 30 days, when a message in the channel is deleted (like traces), and by privacy withdraw.
The export lists them per turn, counts them in SUMMARY.md, and lists the ones not on a turn in the window (mostly gate misses, or a later review of an older turn).

## Export

```sh
pnpm eval:export                      # last 7 days: top 40 flagged + 5 random unflagged baseline turns
pnpm eval:export --since 3d --top 20 --controls 0
pnpm eval:export --no-dms             # leave DM threads out
pnpm eval:export --out evals/out/x    # default evals/out/<timestamp> (gitignored)
```

It writes:

- `SUMMARY.md`: distributions over every finished turn in the window (steps, tokens, latency, subagent tokens),
  flag counts, tool and skill usage, and links to the exported turns. Compare two exports to see if a change helped.
- `turns/NNN-<turnId>.md`: one readable file per turn: flags, request, replies, what the people in the thread said
  next, the front agent's trace step by step, each subagent run.
- `turns.jsonl`: the same data as JSON.
- `prompts/<hash>.md`: the exact system prompts used.
- `ANALYZE.md`: instructions for the analysis pass.

Scoring uses a light projection of each trace (no input, results clipped), so a week of turns fits in memory; only
the exported turns load their full traces.

The export holds real conversation content, DMs included unless `--no-dms`: keep it local and delete it (and the
analysis session's transcripts) once analysed. The privacy policy promises that.

## Analysis

Open a Claude Code session in the repo and say: "Follow `evals/out/<dir>/ANALYZE.md`." The turn files are too big for
one context, so it fans out to subagents that return a short note per turn, then reads those next to the code, groups
findings into patterns (only ones backed by at least two turns, or one severe failure), and writes
`FINDINGS.md` with the root cause, a proposed diff, and the metric that should move. Then make the edits on a branch,
deploy, and after a few days run another export and compare `SUMMARY.md`.

Never put conversation content into commits, PRs or skills: describe the pattern instead.
