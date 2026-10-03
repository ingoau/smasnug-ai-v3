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

Scenarios (DMs): `hi` ("hi! what can you do?"), `factual` (tcp vs udp), `search` ("search slack for messages
mentioning the hackathon venue…", stubbed results), `ship` ("what's the #ship channel for?"), `research` (spawns a
subagent; the run is cancelled right after the turn). `--parallel N` additionally fires N messages at the same
moment in different threads: 3 threads in one user's DM channel (`par-same-dm`), one DM channel per user
(`par-own-dm`), research DMs (`par-research`, also reports how long the subagent run waited in the queue) and
channel mentions (`par-mention`). `--child N [--child-task hard]` benchmarks subagent runs alone (fixed
instructions, per-step timing from `run_step` events).

```
pnpm bench --runs 3 --parallel 8
CHILD_REASONING_EFFORT=default pnpm bench --child 3
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

## After

Medians, same setup (5 runs; `search`/`ship` single-search numbers from a 3-run bench at 30ed70e, see note).

| ms after message | hi | factual | search (1 slack_search) | ship (1 slack_search) | research | par-same-dm | par-own-dm | par-mention |
|---|---|---|---|---|---|---|---|---|
| first status | 1382 → **184** | 1380 → **191** | 1382 → **174** | – → **183** | 1387 → **187** | 1445 → **196** | 1445 → **196** | 1444 → **196** |
| first text | 3541 → **1882** | 4064 → **1942** | 5108 → **3529** | – → **3521** | 5609 → **4613** | 3271 → **1954** | 3301 → **2022** | 3532 → **2117** |
| turn end | 5515 → **2647** | 6513 → **2953** | 9685 → **4801** | – → **4316** | 6095 → **5121** | 5341 → **2853** | 5799 → **2993** | 5418 → **3083** |

Note: with the later front-prompt change ("look it up") the model often delegates the `search`/`ship` questions
(slack_search → spawn → ack) instead of answering after one search; those runs show the ack at ~4.3s (`search`) /
~7s (`ship`, three model steps). That's model behaviour, not pipeline time.

Where the time goes now (hi): intake 15 → status visible 184 (two status calls in parallel) · debounce window
300 → model request ~400 · model TTFT ~1.2s → first reply text ~1.68s · stream open (one Slack call) → first
text ~1.88s · reply streaming → stream stopped ~2.3s · status clear (two serial Slack calls) → turn end ~2.65s.

Parallel (8 and 16 simultaneous threads, incl. 3 in one DM channel and research DMs spawning subagents): every
thread's first text is within ~0.1s of the single-thread number; subagent runs start ~10ms after spawn.

### What changed

| change | effect (hi) |
|---|---|
| Status set at intake for DMs/mentions (fire-and-forget, both calls in parallel), adopted by the turn; turn-start status never blocks the model | first status 1.38s → 0.18s; −0.3s before the model call |
| Debounce window 300ms for messages that skip the gate (DM, mention, two-party, stop); 1s for gated, 3s while subagents run | −0.7s |
| Debounce fired by an in-process timer (delayed job = crash-safe backup, +1.5s) | −0–100ms (Redis expires blocking timeouts on its 10Hz cron) |
| No conversations.replies backfill when the thread's parent is the turn's own message; channel-context reads in parallel | −1 Slack round trip (DMs); mentions −1 |
| ~~Loop ends after a reply-only step (heuristic)~~ replaced: the model calls `end_turn`, usually in the same step as its reply, so the turn still ends without a wrap-up model call | turn end −1.3 s when the model ends in the reply step |
| First stream flush as soon as ~8 chars are there (80ms cap), then 250ms coalescing | first text −0.2–0.4s |
| Redundant inbox-push transaction skipped in debounce fire | −~10ms |
| Per-channel Slack limiter only counts message-creating calls; Postgres pool 10 → 20 | headroom for many threads in one DM channel |
| Subagents: card shows "Researching…" and elapsed time for long steps; Luna subagents at reasoning effort low | lookup run 15s → 6s; broad research 84s → 36s (one run 186s with more fetch steps) |

### Evaluated, not changed

- **Front reasoning effort** (`FRONT_REASONING_EFFORT`, default now `none`): the bench showed no difference because its prompts rarely triggered reasoning, but in real Slack turns with even 29–59 reasoning tokens took ~4.0–4.3s to the first token vs ~1.2–1.5s without. With `none`, the LIVE behaviour tests (delegation, silence, reports, e2e) passed 11/11 twice. Subagents keep `low`.
  (~1.2s; reasoning tokens are already 0 at low). Probe with a tiny prompt and one tool: 0.8–1.1s, so the 8k-token
  prompt (98% cached) costs ~0.2s at most; not worth trimming tool descriptions. Kept `low`; `none` delegated the
  search scenario more often.
- **Queue hops**: debounce → thread-run job pickup is ~1ms; not collapsed.
- **Slack client overhead**: rate limiter (Redis Lua) + idempotency insert/update add ~15ms per keyed call
  (startStream measured 165ms at 150ms fake latency); left as is.
- **Child web search `max_results`** (measured with the old OpenRouter server tool): the first step is dominated by
  model reasoning over the search results (reasoning effort low halves it). Web search is now an Exa client tool
  (default 5 results, highlights only).

### Remaining bottlenecks

- Model TTFT (~1.2s per step on OpenRouter → gpt-6-luna), and one more full step per tool round trip
  (slack_search answers need two steps: ~3.5s to first text).
- Slack network: the bench assumes 150ms per call; on the critical path are the intake status (1 RTT, parallel),
  `chat.startStream` (1 RTT) and at the end `chat.stopStream` + two serial status-clear calls (3 RTT).
- Slack event delivery before ingress (outside our control; not in the bench).
