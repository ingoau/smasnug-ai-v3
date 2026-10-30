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

Retention (`src/features/retention.ts`): traces cascade with their thread, go after the retention window (30 days),
and any trace that may hold a message deleted in Slack goes at deletion time (`applyDelete`) and in the daily pass.
Unreferenced prompt versions go after the window too. `PRIVACY.md` describes all this to users.

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

Turns from before tracing still get the event-based flags (`turn_tools`, `turn_timing`, `run_step` …); the
trace-based ones need traces. Thresholds are in `THRESHOLDS`.

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

The export holds real conversation content: keep it local and delete it once analysed (the privacy policy promises
that).

## Analysis

Open a Claude Code session in the repo and say: "Follow `evals/out/<dir>/ANALYZE.md`." It reads the turns next to the
code, groups findings into patterns (only ones backed by at least two turns, or one severe failure), and writes
`FINDINGS.md` with the root cause, a proposed diff, and the metric that should move. Then make the edits on a branch,
deploy, and after a few days run another export and compare `SUMMARY.md`.

Never put conversation content into commits, PRs or skills: describe the pattern instead.
