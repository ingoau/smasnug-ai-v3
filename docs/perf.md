# Latency

How fast the bot reacts in Slack, how we measure it, and what we changed.

## Instrumentation

Every turn writes one `turn_timing` thread event and a `turn_timing` log line (`src/core/timing.ts`). Marks are
ms after the user's message (its Slack `ts`):

| mark | where |
|---|---|
| `ingress_received`, `enqueued` | ingress (Socket Mode handler) |
| `intake_start`, `debounce_scheduled` | slack-events job (`intake.ts`) |
| `status_intake` | intake status call returned (DM / mention) |
| `debounce_fired`, `turn_created` | turn-debounce job (`fire.ts`) |
| `run_picked`, `lock_acquired`, `turn_claimed` | thread-run job |
| `status_done` | turn-start status call returned |
| `context_start`, `context_built` (+ spans `ctx_*`) | front turn context (backfill, users.info, history, memory, facts, snapshot) |
| `model_request`, `first_chunk`, `first_tool_input`, `first_reply_delta` | model stream |
| `stream_started` / `reply_posted`, `stream_stopped` | reply delivery |
| `stepN_end`, `loop_done`, `turn_end` | model steps, end of loop, end of turn (status cleared) |

Counters: model steps, input / output / reasoning / cached tokens, prompt chars; notes: tool names per step.
Per-message marks cross processes via a 10-minute Redis hash (`timing:msg:<channel>:<ts>`), written
fire-and-forget.

## Benchmark

`pnpm bench` (`scripts/bench.ts`) runs the real pipeline in-process (ingress handler → slack-events → debounce →
thread-run → front agent with the real OpenRouter model) with `SLACK_FAKE=1`, a fake per-call Slack latency
(`SLACK_FAKE_LATENCY_MS`, bench default 150ms) and the shared rate limiter enabled (`SLACK_FAKE_LIMITER=1`), on its
own database `smasnug_bench` and Redis db 11 on the test servers (never the dev ones; guarded like the tests).

Scenarios (DMs): `hi` ("hi! what can you do?"), `factual` (tcp vs udp), `search` (one `slack_search`, stubbed
results), `research` (spawns a subagent; the run is cancelled right after the turn). `--parallel N` additionally
fires N messages at the same moment in different threads: 3 threads in one user's DM channel (`par-same-dm`), one
DM channel per user (`par-own-dm`) and channel mentions (`par-mention`).

```
pnpm bench --runs 3 --parallel 8
```

Model latency (OpenRouter → `openai/gpt-6-luna`) varies a lot run to run (single runs of 15s happen); compare
medians, and phase marks before `model_request` are deterministic enough to compare directly.

## Baseline (before, commit a456c8c + instrumentation)

Medians of 3 runs, ms after the user's message, fake Slack latency 150ms/call.

| | hi | factual | search | research | par-same-dm | par-own-dm | par-mention |
|---|---|---|---|---|---|---|---|
| first status | 1382 | 1380 | 1382 | 1387 | 1445 | 1445 | 1444 |
| first text | 3541 | 4064 | 5108 | 5609 | 3271 | 3301 | 3532 |
| turn end | 5515 | 6513 | 9685 | 6095 | 5341 | 5799 | 5418 |

Where the time goes (hi):

| phase | ms | note |
|---|---|---|
| debounce | 26 → 1040 | 1s idle window (+~15ms BullMQ delayed-job latency) |
| debounce → turn claimed | 1040 → 1073 | two queue hops, redundant inbox-push transaction |
| status | 1073 → 1382 | awaited: `agents.sessions.setStatus` then `assistant.threads.setStatus`, serial |
| context | 1385 → 1557 | ~160ms is `conversations.replies` backfill of a brand-new DM thread |
| model TTFT | 1557 → 3105 | ~1.2–1.5s to the first chunk (reasoning tokens: 0) |
| first stream flush | 3106 → 3511 | 300ms flush timer, often a second one (first delta has no text yet), then `chat.startStream` |
| wrap-up model call | 3891 → 5196 | after the reply-only step, a second model call that just ends the turn (~1.3s) |
| status clear | 5196 → 5515 | two serial Slack calls |

Parallel: 8 simultaneous threads (same DM channel, separate DMs, channel mentions) all get first text within
~0.3s of the single-thread numbers; nothing serialises at this load.
