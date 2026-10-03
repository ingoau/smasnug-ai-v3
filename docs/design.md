
# Slack Agent — Design Doc
2026-10-03 · @Ingo
## Overview
A workspace-wide Slack agent for the Hack Club Slack, built around a fast front agent that delegates longer work to background subagents. The focus is UX: the bot feels responsive, shows its work in native plan cards, stays quiet when it has nothing to add, and never spams threads.
**In v1:**
- 
A front agent that replies, reacts, sends messages on users' behalf, steers subagents, and manages memory
- 
General-purpose background subagents with Slack search, web search, URL fetch and image reading
- 
Native Slack plan cards for subagent progress, with steering and resume
- 
Per-user memory and an admin-approved workspace knowledge base
- 
Abuse controls: limits, reports, auto-suspension
**Deferred:** a code sandbox for subagents (decisions recorded in Deferred and open items), and coding agents that open PRs.
**Scale:** a few users at first, but the architecture is built to scale horizontally from day one. Hosted at home or on a VPS.
## Stack and architecture
TypeScript on the Vercel AI SDK and Chat SDK, with models through OpenRouter. Ingress and workers are separate processes from day one so the bot scales horizontally.
Layer
Choice
Language
TypeScript
Slack
Chat SDK for streaming and plan chunks; `@slack/web-api` for card updates, ephemeral confirmations, custom username and icon, file uploads
Agent loop
Vercel AI SDK tool loop. A per-step hook drains the inbox; streamed tool input feeds the `reply` stream
Models
OpenRouter. GPT-6 Luna for the gate (reasoning off), front agent (low) and subagents; GPT-6 Sol for subagent tasks Luna struggles with
Storage
Postgres for the event log, runs, memory and locks; Redis for the shared rate limiter and short-lived coordination
Hosting
Home server or VPS, Slack Socket Mode so nothing is exposed publicly
Ingress never calls a model, so events are always acked within Slack's 3-second window. Workers hold no per-thread state in memory: locks, inboxes and debounce timers live in Postgres and Redis, so any worker can take any thread. `fetch_url` and emoji search call the web directly.
**Per-thread event log.** Everything that happens in a thread is an append-only event: user messages (with edits and deletions), turns, spawns, steers, run progress, results and sends. The front agent's context, the plan cards, traces and eval replays are all derived from it.
**One Slack client.** Every Slack call goes through a single wrapper with per-method and per-channel rate limits (shared across workers via Redis), backoff on 429s, card-update coalescing, and idempotency keys on every side effect.
## Agent roles and tools
Three roles, each granted tools from one shared registry. Safety rules come from what each role is given, not from prompts.
- 
**Gate:** a cheap relevance check that decides whether the bot should respond to an unmentioned follow-up. No tools; outputs yes or no.
- 
**Front agent:** the only agent that talks to users. Handles one speaker per turn, replies, reacts, spawns and steers subagents, and manages memory. Keeps its own research to one or two quick lookups and delegates anything longer.
- 
**Subagents (children):** one general type, no specialised agents. Do longer work in the background and return results to the front agent. Never post to Slack, never touch memory.
Tool
Gate
Front agent
Children
Slack search (user token, public channels only)

✓
✓
Web search (`openrouter:web_search`)

✓
✓
Fetch URL (no local addresses)

✓
✓
`read_image`, `read_thread`, `read_channel`

✓
✓
`reply`, `send_message`, `react`, `search_emojis`

✓

`spawn_subagent`, `message_subagent`, `cancel_subagent`

✓

`set_card_title`

✓

`remember`, `forget`, `propose_workspace_fact`

✓

Plain text output from the front agent is never shown to users; everything visible goes through tools. Discarded text is logged for debugging.
## When the bot responds
The bot always runs on a mention or DM. In threads where it has been mentioned, follow-ups pass through three layers so it replies when it is useful and stays quiet otherwise.
- 
**Deterministic rules.** A mention or DM always runs the front agent. A message that @mentions someone else and not the bot is skipped. A thread containing only the original user and the bot goes straight to the front agent.
- 
**Relevance gate.** Everything else goes to a small, fast model with the last few messages and the new one. It answers one question: is this addressed to the bot, or would the bot clearly add something? Decisions are logged for tuning.
- 
**Front agent.** On yes, the front agent runs and can still choose silence by not calling `reply`.
**Never triggered by bots.** Messages from bots (`bot_id` or `subtype: bot_message`), including the bot's own and its on-behalf-of messages, never start a turn. Bot messages are still included in context, labelled as bots.
**Disengagement.** If the bot hasn't been addressed for about 10 messages or a few hours, it stops considering follow-ups until mentioned again. "Stop" or "shut up" also disengages it.
**Status indicator.** `agents.sessions.setStatus` (`processing` at turn start, `active` when the turn ends) is shown for mentions and DMs only; `processing` also shows Slack's native stop button, which behaves like saying "stop". Unmentioned follow-ups show no typing indicator and no acknowledgement reaction.
## Turns
Every front-agent turn has exactly one speaker, and only one front agent runs per thread at a time. This keeps "current speaker" well defined for memory, tools and steering.
**Debounce per (thread, author).** Messages from the same person within the window merge into one turn; messages from different people never merge. The window scales: about 1 second when the thread has no running subagents, 3 seconds when it does. It is re-evaluated as each message arrives.
- 
An edit during the window replaces the message in the batch.
- 
A deletion during the window removes it; if that empties the batch, the turn is cancelled.
**Sequential turns.** If two people message at once, their turns run one after the other. The second turn sees the first turn's messages and reply as ordinary thread context.
**Messages arriving while a turn runs:**
- 
The message goes through its debounce window first.
- 
If no turn is running, a new turn starts.
- 
If the running turn belongs to the same author and has a tool boundary coming, the message is pushed to the thread inbox and injected before the next model call.
- 
If the running turn is in its final reply (no more tool calls), or belongs to a different author, the message waits and starts a new turn right after.
Turns are never hard-interrupted. "Stop" is injected like any other message, and the agent responds by cancelling subagents and staying quiet.
## Subagents
Subagents are persistent sessions within a thread; each piece of work on one is a run. Steering a running subagent and following up on a finished one are the same operation.
```

```

**Front agent tools:**
- 
`spawn_subagent(title, instructions)` creates a subagent and starts its first run.
- 
`message_subagent(id, text)`: if running, pushes to its inbox; if idle, starts a new run on the same session with full prior history; if cancelled, errors so the agent spawns a new one.
- 
`cancel_subagent(id)` sets a flag the subagent checks between steps.
**Inbox and steering.** Each subagent loop drains its inbox before every model call and appends messages as `[Orchestrator update] …`. Injection only happens at turn boundaries, never mid tool call.
**Ownership.** Each subagent records the user who spawned it. The front agent sees message authors and subagent owners, and is prompted not to steer or cancel another user's subagent without the owner's confirmation. This is prompt-only, not enforced in code.
**Results.** Subagents never talk to users. Their results go back to the front agent, which writes the answer in its own voice. Failed and cancelled runs are reported in the synthesis, not dropped.
**History.** Subagent history is persisted (Postgres). When a run ends, old tool results are compacted to summaries so long-lived subagents don't grow without bound.
**Front agent snapshot.** Every turn includes a list of the thread's subagents, running and idle, with owner, status and a one-line summary, so the agent can reuse an idle subagent instead of starting from scratch.
**Expiry.** Idle subagents expire after about 24 hours and drop out of the snapshot. A later follow-up spawns a fresh one, seeded with the old summary.
**Deploys and crashes.** Workers heartbeat while running. A sweeper marks runs with stale heartbeats as errored and updates their cards. On shutdown, in-flight runs are marked errored before exit. Runs are not resumed after a restart.
## Slack UX
Everything the user sees is produced through tools, and code decides how it's delivered.
### Reply tool and delivery
- 
`reply(text, files?)` posts in the current thread. Not calling it is a valid choice: a steer often needs only a reaction and a card note.
- 
Multiple `reply` calls per turn are allowed (for example, one before spawning, one after), but most turns have one or none.
- 
If a turn ends with no reply, no card change and no spawn, fall back to posting a short message so the user isn't left with silence.
- 
Reply text is markdown, sent via the `markdown` block.
State
Delivery
No subagents running
Stream the reply (`chat.startStream` / `appendStream` / `stopStream`), text forwarded from the tool's streamed arguments via a partial-JSON parser
Subagents running
No stream. Steers fold into the plan card; other replies are posted whole with `chat.postMessage`
All subagents finished
Front agent streams its synthesis into a new message below the card
The stream-or-post choice is made in code from `thread.tasks.some(running)`, never by the model.
### Plan cards
- 
A card is attached to the reply of the turn that started runs, and shows only the runs started in that turn. One task row per run.
- 
Steering a running subagent does not create a card. The steer appears on the original card's row as `↪ also checking #ship`.
- 
Resuming an idle subagent is a new run, so it appears on the new turn's card, marked `↻`.
- 
Cards are updated with `chat.update`, never a held-open stream. The message is a pure render of task state from the DB; children write progress to the DB and schedule a re-render.
- 
Updates are coalesced per thread to at most one every 1–2 seconds, always rendering the full latest state. Always set `text` alongside `blocks`.
Run state
Task status
Row content
Queued
`pending`
`details: "Queued"`
Running
`in_progress`
`details`: current step, steer note
Finished
`complete`
`output`: one-line result
Failed
`error`
Short reason
Cancelled
`error`
`details: "Cancelled"`
**Titles.** Live cards use a deterministic title ("Running 2 subagents"). On finish, the front agent calls `set_card_title` before writing its synthesis, and the card freezes with that title. If the call is skipped or the title is over ~40 characters, fall back to "Ran N subagents". Frozen cards stay visible as a record, with buttons removed.
**Cancel.** One "Stop all" button in an actions block under the plan while anything runs. Individual subagents are cancelled by asking in text.
### Reactions and emoji
- 
`react(emoji)` takes any emoji name. The model is prompted on when to react, and that steers should get a visible acknowledgement nearby (a reaction or short reply), since the original card may be far up the thread.
- 
`search_emojis(query)` is backed by semoji (`/v1/search`, hybrid mode), returning name and summary for about 8 results. Results are cached; timeout ~1s.
- 
If a lookup fails or `reactions.add` returns `invalid_name`, fall back to `thumbsup` or skip silently.
### Files
The `reply` and `send_message` tools accept file attachments, uploaded via `files.getUploadURLExternal` and `files.completeUploadExternal`. When a reply is streamed, files are uploaded after `stopStream` so they land just below it.
## Context, images and the web
### Thread context
Each turn includes the thread's parent message plus the last 29 replies, and about 5 channel messages from around the thread's parent.
- 
If replies are omitted, a marker says so: `[42 earlier replies not shown]`.
- 
Every message is labelled with its author: `<@U123> Ingo: …`; bots as `[bot] Gorkie: …`.
- 
Messages over a few hundred tokens are truncated with `[truncated]`.
- 
Attachments appear as placeholders, e.g. `[file: budget.csv]`.
For more, the front agent can call `read_thread(before_ts, limit)` and `read_channel(before_ts, limit)`, or delegate a summary of a long thread to a subagent. The bot token only reads channels the bot is in.
### Prompt layout
Stable parts come first so the provider's prompt cache can reuse them: system prompt, tool definitions, workspace facts. Per-turn parts come last: speaker memories, subagent snapshot, speaker time zone and current time, thread history, new messages. Each section has a token budget; overflowing sections are summarised or left to the agent's read tools.
### Images
- 
Images appear in context as `[image img_3: screenshot.png, from Ingo]`. IDs are stable per thread.
- 
`read_image(id)` downloads the file with the bot token, resizes to ~1500px on the long side, converts HEIC and GIF (first frame), caches it, and returns it to the model.
- 
IDs only resolve for images in that thread's context, so a subagent can't read arbitrary Slack files.
- 
Subagents get the same tool; the front agent passes relevant IDs in its instructions.
- 
If the model doesn't accept images in tool results, the tool returns "image loaded" and the image is appended as a user message instead.
### Web search
OpenRouter's `openrouter:web_search` server tool, available to the front agent and subagents. The model decides when to search; OpenRouter runs it. The default engine is `auto` (native provider search, falling back to Exa). Set `max_results` to 3–5 to keep costs down. Server tools are in beta. Searches count towards per-user limits.
### Fetch URL
A custom `fetch_url` tool, available to both roles, that can never reach local addresses:
- 
http and https only.
- 
Resolve DNS first and reject loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16), CGNAT (100.64/10) and IPv6 equivalents (`::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped).
- 
Connect to the checked IP to prevent DNS rebinding, and re-check every redirect.
- 
Cap at a few MB and ~10 seconds; convert HTML through Readability to markdown.
- 
Use a connection-level library such as `request-filtering-agent` rather than hand-written IP checks.
Fetched pages and search results are treated as untrusted data.
## Sending on behalf of users
`send_message(destination, text, files?)` can post to the thread's channel, another channel, or a DM. Anything sent outside the current thread is attributed to the requesting user and confirmed first.
**Confirmation (code-enforced).** Before sending outside the thread, the bot posts a `chat.postEphemeral` preview to the requester: destination, the message as it will appear, and Send / Cancel buttons. The pending send is stored server-side and expires after a few minutes; a stale click replies "This expired, ask again."
**Attribution.** Messages are sent with `chat.postMessage` using `username` (`[bot] on behalf of [user]`) and `icon_url` (the user's profile image), which requires the `chat:write.customize` scope. A context block at the bottom repeats "Sent by @user via [bot]" and holds the report button, so attribution survives in clients that ignore the custom display. The bot must be in the channel, or have `chat:write.public` for public channels. Outgoing sends count towards per-user limits.
## Reports and suspension
- 
**Report button.** Snapshots the message content, sender, destination and permalink into a moderation channel, and replies to the reporter with an ephemeral "Thanks, reported".
- 
**Records.** Every on-behalf-of send stores the message-to-user mapping, so reports keep the original sender even if the message is later edited or deleted.
- 
**Moderation actions.** Reports include a delete button and an action to block the user from the send tool.
- 
**Auto-suspension.** A user reported by more than a threshold number of distinct reporters is suspended until reviewed. Suspension is checked at every entry point, not only sends.
- 
**Reviewer.** Ingo handles all reports.
## Memory
Two kinds: per-user memory, written mostly by a background pass, and a small workspace knowledge base that you approve. Thread memory is the event log itself.
### Per-user memory
**Storage.** One row per fact: `id`, `user_id`, `text`, `source_thread`, `created_at`, `last_used`. Facts not used for about six months expire.
**Background extraction.** When a thread has been idle for about 30 minutes, a Luna pass reads it alongside each participant's existing facts and adds, updates or removes facts. It only runs over conversations with the bot, never over the wider workspace.
- 
Only facts users stated about themselves, never inferences.
- 
A fact from a user's messages can only be written to that user's memory (enforced in code).
- 
No sensitive categories (health, family situations and similar) and nothing about other people's private lives.
**Tools.** The tools take no user ID; the user is always the current speaker.
- 
`remember(fact)` writes to the speaker's memory immediately.
- 
`forget(fact_id)` deletes one of the speaker's facts. Injected facts show IDs, e.g. `[m_42] prefers short answers`.
- 
Facts about other people are stored in the speaker's own memory, attributed: `Ingo says Sam is handling venues`. They never shape how the bot treats Sam.
**Reading.** Only the current speaker's facts are injected into a turn, capped at about 20, labelled as private context for personalising answers, not for reciting. Other participants' memories are never included. When a user's facts outgrow the cap, add pgvector embeddings and a speaker-scoped `search_memory` tool.
**Subagents** never read or write memory. The front agent passes anything relevant in its instructions.
### Workspace knowledge
Facts about the Slack itself (what channels are for, recurring events). The front agent calls `propose_workspace_fact(fact)`, which sends the fact to the moderation channel for approval. Each fact keeps its source thread and proposer. Approved facts are injected into every turn; only Ingo can delete them. Subagent findings reach this through the front agent.
### User control
An App Home tab lists each user's own facts with delete buttons and a "forget everything" option. "Forget X" in conversation uses `forget`. Deletion is a hard delete, including embeddings.
## Safety, limits and reliability
### Limits
Per user: messages per hour, concurrent subagents, searches and fetches, and on-behalf-of sends. Per thread: max concurrent subagents. Per run: max duration and a token cap. At GPT-6 Luna's prices these exist mainly to stop abuse and runaway loops, not to control budget.
### Kill switches
A global pause flag, per-channel disable for channel owners, and a per-user block list (shared with suspension).
### Reliability
- 
**Event deduplication.** Dedupe on `event_id` and the `X-Slack-Retry-Num` header so Slack retries never cause double replies.
- 
**Idempotent side effects.** Every send, reaction, upload and card post carries an idempotency key derived from its event, checked before acting.
- 
**Liveness.** Workers heartbeat during runs; a sweeper marks stale runs as errored and updates their cards. Clean shutdowns mark in-flight runs errored before exit.
- 
**Model or API outages.** Post a short "Something broke, try again" rather than going silent.
### Observability and testing
- 
Trace every turn and run: prompts, tool calls, gate decisions, tokens, latency, cost. PostHog LLM analytics, Langfuse or similar.
- 
Build evals from saved threads (with permission), especially steer versus new task, silence, and ambiguous follow-ups. Replay them after prompt changes.
- 
Develop against a separate Slack app in a test workspace.
### Retention
The community is mostly teenagers, so keep only what's needed. Thread event logs, subagent histories and traces are deleted after 30 days. Stored copies of Slack messages are deleted when the original is deleted. Per-user memory is the exception: it persists until deleted by the user or expired by `last_used`.
## Deferred and open items
### Sandbox (deferred)
Decisions already made for when it's added:
- 
One sandbox per subagent, reused on resume, paused when idle.
- 
Hard limits on CPU, memory and wall-clock time; no secrets inside.
- 
Egress blocked to private address ranges and the host, so it can't reach the home network. Prefer running sandboxes on the VPS or a hosted provider (E2B, Daytona, Modal) even if the bot runs at home.
- 
Tools: `exec`, `read_file`, `write_file`; outputs attached to replies as files.
- 
Added as a registry entry granted to children only.
### Not planned
- 
Coding agents that open PRs.
- 
Memory extraction over workspace messages beyond conversations with the bot.
- 
Writing memory about other users.
### Open questions
- 
Does GPT-6 Luna via OpenRouter accept images in tool results, or is the user-message fallback needed?
- 
Does the AI SDK's OpenRouter provider pass `openrouter:*` server tool types through?
- 
Can a message be edited with `chat.update` after `stopStream`?
- 
Does `assistant.threads.setStatus` render for mentions in regular channels?
- 
Exact values for per-user limits and the auto-suspension report threshold.