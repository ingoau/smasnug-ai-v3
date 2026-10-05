
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
TypeScript on the Vercel AI SDK and Chat SDK, with models through Hack Club AI (an OpenRouter proxy), falling back to OpenRouter. Ingress and workers are separate processes from day one so the bot scales horizontally.
Layer
Choice
Language
TypeScript
Slack
Chat SDK for streaming and plan chunks; `@slack/web-api` for card updates, ephemeral confirmations, custom username and icon, file uploads
Agent loop
Vercel AI SDK tool loop. A per-step hook drains the inbox; streamed tool input feeds the `reply` stream
Models
Hack Club AI first, OpenRouter as fallback. GPT-6 Luna for the gate (reasoning off), front agent (low) and subagents (low)
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
Slack search (user token, public channels only: each result's channel is verified public via cached `conversations.info`, fail closed; counts come from the filtered list). Hits show Slack's nearby messages (`previous`/`next`, same channel, `##` dropped) and mark thread replies; `read_public_thread` opens any public-channel thread (user token, `channels:history`, same public check)

✓
✓
Semantic Slack search (`slack_semantic_search`, Slack Real-time Search; secondary, rare; see below)

✓
✓
Web search (`web_search`, Exa)

✓
✓
Fetch URL (no local addresses)

✓
✓
`read_image`, `read_thread`, `read_channel`, `read_public_thread`

✓
✓
`reply`, `send_message`, `react`, `search_emojis`

✓

`spawn_subagent`, `message_subagent`, `cancel_subagent`

✓

`set_card_title`

✓

`set_session_title` (DM threads only)

✓

`remember`, `forget`, `propose_workspace_fact`

✓

`read_canvas` (canvases shared in this conversation or a verified public channel, or the bot's own made here or in a public channel; see Canvases and artifacts)

✓
✓
`create_canvas`, `edit_canvas` (edit: the bot's own canvases, for their creator only)

✓

`set_reminder`, `list_reminders`, `cancel_reminder`, `create_watch`, `list_watches`, `cancel_watch` (owner = speaker)

✓

`spawn_coding_agent` (admin only, Cursor, launched only after the admin's Launch click; see Coding agents)

✓

Plain text output from the front agent is never shown to users; everything visible goes through tools. Discarded text is logged for debugging.
## When the bot responds
The bot always runs on a mention or DM. In threads where it has been mentioned, follow-ups pass through three layers so it replies when it is useful and stays quiet otherwise.
- 
**Deterministic rules.** A mention or DM always runs the front agent. A message that @mentions someone else and not the bot is skipped. A thread containing only the original user and the bot goes straight to the front agent.
- 
**Relevance gate.** Everything else goes to a small, fast model with the last few messages and the new one. It answers one question: is this addressed to the bot, or would the bot clearly add something? Decisions are logged for tuning. Implementation: TypeSafe's Jev (`typesafe/jev-1.13`) through OpenRouter's Decisions API answers one typed yes/no question with a probability (respond at ≥ 0.8, `GATE_THRESHOLD`); ~0.45s vs ~1.2s for a chat model, 95% agreement with the earlier Luna gate on 39 logged decisions. Any Decisions API error or a 1.5s timeout falls back to the Luna chat-model gate; every `gate_decision` event logs the model, probability and any fallback.
- 
**Front agent.** On yes, the front agent runs and can still choose silence by not calling `reply`.
**Never triggered by bots.** Messages from bots (`bot_id` or `subtype: bot_message`), including the bot's own and its on-behalf-of messages, never start a turn. Bot messages are still included in context, labelled as bots.
**Disengagement.** If the bot hasn't been addressed for about 25 messages or a few hours, it stops considering follow-ups until mentioned again. "Stop" or "shut up" also disengages it.
**Workspace AI-bot guidelines** (enforced in code: pure checks in `src/pipeline/guidelines.ts`, side effects in `src/pipeline/guideline-actions.ts`; they apply in channels, threads and DMs and run before the rules above):
- 
`##` **prefix: ignored completely.** A message whose trimmed text starts with `##` (mention or not) is never stored, adds no thread events, never triggers a turn, the gate or a debounce batch, and doesn't count toward limits or disengagement. It is also hidden from everything the bot reads: thread/channel backfill, `read_thread`/`read_channel` and `slack_search` results. Editing a message to start with `##` is treated like deleting it (stored copy blanked, dropped from batches and pending turns). Editing the `##` away never triggers a turn; a copy that was blanked stays blank, a never-stored one may be stored as plain context.
- 
`@bot !stop` **= the native stop button.** A message mentioning the bot whose remaining text is `!stop` (case-insensitive) runs the `agent_session_stopped` handler for its thread (stop the running turn at the next step, cancel the thread's runs, drop the user's pending turns/inbox/batch, disengage, set the session `active`, post "Stopped."); it never starts a turn itself. In DMs the mention is optional. At a channel's top level it applies to that message's own (empty) thread, so it's harmless.
- 
**Group ping on a top-level trigger → answer elsewhere.** When the message that triggers the bot is a top-level channel message that pings a user group (`<!subteam^…>`) or `@channel`/`@here`/`@everyone`, the bot doesn't reply under it. It posts a new top-level message ("<@user> asked me something in <this message>, replying here so the group thread stays clean", idempotent on the source ts, no group ping), stores the user's message as part of that new thread, and runs the turn there (replies, cards and status included). Follow-ups in the new thread work normally (the asker counts as the thread's original poster for the two-party rule); the group-ping thread is never engaged. Thread replies and DMs with group pings are answered in place.
- 
`<>` **prefix: don't reply unless mentioned.** A message whose trimmed raw text starts with a literal `<>` (Slack delivers it as `&lt;&gt;`) never triggers a turn or the gate unless it @mentions the bot, in which case it's a normal mention. It is still stored and visible as context. DMs included.
- 
**The bot never pings groups.** `reply` text (also while streaming) and card fallback text have `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^…>` and plain `@here`/`@channel`/`@everyone` neutralised; `send_message` already did this.
**Status indicator.** The agent session's lifecycle via `agents.sessions.setStatus`: `processing` (Slack's "Working…" plus the native stop button, which behaves like saying "stop") and `active` when the turn ends, always (also on errors). Mentions and DMs show it as soon as the message is accepted at intake, before the debounce window; the turn takes it over, and it is cleared if no turn follows. Status calls never delay the model call. Unmentioned follow-ups show it only once the turn commits to work — its first tool call other than `reply`/`react`/`unreact`/`search_emojis` (and the bookkeeping `set_session_title`/`leave_thread`); a turn that stays silent or goes straight to `reply` never shows a status (the streamed reply is its own indicator) and gets no acknowledgement reaction. A reply stream that ends mid-turn sets the session `active` (`chat.stopStream`'s default), so the next tool call sets `processing` again — except bookkeeping after the reply (remember/forget, workspace facts, reminders/watches), which leaves the indicator alone. A turn the user stopped never sets `processing` again. **Activity text** ("Searching Slack…", "Reading the page…", "Starting a subagent…", code-derived from the tool being started; "Searching the web…" for web search): the deprecated `assistant.threads.setStatus` (the only free-text status, removed with `assistant_view` in February 2027) is no longer used, and `agents.sessions.setStatus` takes no custom text. Instead (`STATUS_ACTIVITY_MODE=tasks`, default) the activity is a transient `task_update` card in the turn's reply message: the first activity opens a stream holding just that card, later ones mark it complete and add the next (at most one update per second, latest wins, unchanged text skipped). The turn's next reply streams into that message below the cards, and its final layout (`chat.update`, retried briefly on `streaming_state_conflict`) drops them, so the finished message is exactly the reply; a reply posted whole (subagents running) deletes the activity message instead, and so does the end of a turn that never replied (silent, error, stop), so nothing is left behind. A reply doesn't adopt the activity message when anything was posted in the thread after it (it would land above that post) or when Slack already ended its stream (only a confirmed user stop drops the reply): the activity message is deleted and the reply opens its own. Cards only show in turns that are expected to reply (DMs, mentions, reminder turns, subagent write-ups) and only until the turn's reply is visible; unmentioned follow-ups get just the lifecycle status (a card posted and deleted in a channel thread can notify its followers). A worker crash or shutdown mid-turn leaves none behind: the open activity message is recorded per turn in Redis, and the stale-turn sweep / shutdown deletes it and sets the session's final status. If Slack refuses a cards-only stream, the turn just shows "Working…". `STATUS_ACTIVITY_MODE=off`: "Working…" only. In DMs the session also gets a title and richer statuses (see Agent sessions in DMs).
## Turns
Every front-agent turn has exactly one speaker, and only one front agent runs per thread at a time. This keeps "current speaker" well defined for memory, tools and steering.
**Debounce per (thread, author).** Messages from the same person within the window merge into one turn; messages from different people never merge. The window scales: about 300 ms for messages that skip the relevance gate (DMs, mentions, two-party follow-ups, "stop"), about 1 second for gated messages, 3 seconds while the thread has running subagents. It is re-evaluated as each message arrives. A same-author message that misses the short window still reaches the running turn through its inbox (or starts the next turn once the reply is out).
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
If a turn ends with no reply, no reaction, no card change and no spawn, fall back to posting a short message so the user isn't left with silence.
- 
Reply text is markdown, delivered exactly as the model wrote it (`src/agent/slack-markdown.ts`): prose as `markdown` blocks, fenced code as `rich_text` blocks with a `rich_text_preformatted` element (always with a `language`, else Slack drops the rich code component). Reason: Slack's markdown converter rewrites `<h1-6>`, `<code>` and `<img>` into markdown everywhere, even inside code (verified); in prose only those tags' `<` is written as `&lt;`, and a paragraph whose inline code contains one is rendered as `rich_text`. Streams run in `chunks` mode: prose as `markdown_text` chunks, each code block held until its fence closes and sent as a `blocks` chunk; a stream that carried blocks is re-rendered with `chat.update` after `stopStream` so its final layout equals the posted one. No other rewriting of model output (no citation-marker stripping); group pings are still neutralised.
State
Delivery
No subagents running
Stream the reply (`chat.startStream` / `appendStream` / `stopStream`), text forwarded from the tool's streamed arguments via a partial-JSON parser
Subagents running
No stream. Steers fold into the plan card; other replies are posted whole with `chat.postMessage`
All subagents finished
Front agent streams its synthesis into a new message below the card
The stream-or-post choice is made in code from `thread.tasks.some(running)`, never by the model.
### Quick-reply buttons
- 
`reply(text, files?, buttons?)`: `buttons` is an optional list of 1–5 short labels (≤ 30 chars asked for in the description; shown as written: code only neutralises group pings, drops empty labels, cuts at Slack's 75-char button limit and keeps at most 5; the schema stays lenient so a violation can't fail a reply whose text already streamed). The prompt asks for them only when the reply ends with a question with a few clear answers; each label is exactly what the user would reply.
- 
Rendering: an `actions` block (`block_id` `reply_<id>_buttons`, `action_id` `reply:choice:<i>`, `value` = `reply_buttons.id`) right under the reply markdown. Posted replies include it directly. Streamed replies pass it as `blocks` to `chat.stopStream` (documented: "A list of blocks that will be rendered at the bottom of the finalized message"; separate 50-block limit). If that is refused, the stream is stopped plainly and the buttons are added with `chat.update`; if that fails too, they are posted as a small follow-up message (logged).
- 
State lives in `reply_buttons` (labels, message ts + text, presser, pressed label, the press's message ts). A plan card attached to the same reply re-renders [reply, buttons or pressed note, plan] from the DB.
- 
Press (`reply:choice`): entry guard (counted as a message; blocked users get nothing, rate-limited ones an ephemeral); the first press is claimed atomically (`pressed_at is null`), later presses get an ephemeral "already answered". The buttons are replaced by a context block "<@presser> pressed *label*" (`chat.update`, through the card renderer when a card lives there). Then it acts as if the presser replied with the label: a synthetic message (ts = the action's `action_ts`) is stored, a `message` event appended, the thread marked addressed/engaged, and a mention turn scheduled for the presser (inbox push into their running turn, or a pending turn). The presser is the turn's speaker.
- 
Context: the bot's reply shows `[buttons: A | B]` (`[buttons: A | B; Ingo pressed "B"]` once pressed) and the press renders as `<@U> Ingo: B (button)`.
### Plan cards
- 
A card is attached to the reply of the turn that started runs, and shows only the runs started in that turn. One task row per run. Implementation: after the turn, the turn's last reply message is updated (`chat.update`) to [reply markdown, plan]; every re-render rewrites the reply text plus the current plan. If that update fails (e.g. Slack refuses `chat.update` on a streamed message — unverified), the card is posted as its own message and a `card_attach_failed` event + warning (with the Slack error code) is logged. A turn without a reply posts the card alone.
- 
Steering a running subagent does not create a card. The steer appears on the original card's row as `↪ also checking #ship`.
- 
Resuming an idle subagent is a new run, so it appears on the new turn's card, marked `↻`.
- 
Task rows show results, not just a one-liner: a finished run's `output` is its summary in bold plus a markdown→rich_text excerpt of `runs.result` (≤ 600 chars / 8 lines with ≤ 3 runs, 300/4 with ≤ 6, 150/2 with ≤ 12, summary only beyond); failed runs show the reason, cancelled ones "Cancelled". `sources` lists the URLs the run used (`runs.sources`: fetch_url targets and web-search result URLs, tracking params stripped, deduped; falls back to URLs in the result text), up to 5 (fewer with more runs). Slack documents a 50-task limit per plan (enforced: latest 50) and 50 blocks per message; no per-task output limit is documented.
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
**Cancel.** No buttons on the card. Subagents are cancelled by asking in text ("stop", "cancel the X one") or with Slack's native stop button while a turn is processing. (Cards posted before this change kept a "Stop all" button; its `card:stop_all` handler stays registered so those still work.)
### Reactions and emoji
- 
`react(emoji)` takes any emoji name. The model is prompted on when to react, and that steers should get a visible acknowledgement nearby (a reaction or short reply), since the original card may be far up the thread.
- 
`search_emojis(query)` is backed by semoji (`/v1/search`, hybrid mode), returning name and summary for about 8 results. Results are cached; timeout ~1s.
- 
If a lookup fails or `reactions.add` returns `invalid_name`, fall back to `thumbsup` or skip silently.
### Files
The `reply` and `send_message` tools accept file attachments, uploaded via `files.getUploadURLExternal` and `files.completeUploadExternal`. When a reply is streamed, files are uploaded after `stopStream` so they land just below it.
### Canvases and artifacts
Long-form deliverables (research write-ups, guides, plans, comparison tables) go into a Slack canvas instead of a wall of text: the front agent calls `create_canvas(title, content)` and replies with a short summary plus the link. Subagents only read canvases; for long deliverables they return the full markdown and the front agent publishes it with `create_canvas(from_subagent)`, which copies the stored `runs.result` server-side (the front agent's synthesis view is clipped, and re-emitting a whole document as tool args is slow and lossy). Code, scripts and HTML prototypes are attached as files through `reply(files)` (any text file; Slack picks the type from the extension).
- 
**read_canvas(canvas, offset?)** (front + children): link (`https://<ws>.slack.com/docs/T…/F…`, also `app.slack.com/docs/…` and `/files/U…/F…` permalinks) or `F…` id. Fail closed, allowed only when: the bot created it in this conversation or in a verified public channel (not "anywhere for its creator": a canvas made in a private channel, group DM or DM may hold others' private messages or the creator's memories); or it is shared in / linked to the current conversation; or it is shared in / linked to a channel verified public via cached `conversations.info` (same check as Slack search). Where it is shared comes from `files.info` with the bot token (`channels`, `groups`, `ims`, `shares`, `linked_channel_id`), so canvases the bot can't see are refused. Content from `canvases.getContent` (markdown; canvas mentions `![](@U…)` turned back into `<@U…>`), wrapped as untrusted together with the title (both are author-controlled), 24k chars per call with `offset` paging. Counted against an hourly per-user limit.
- 
**create_canvas(title, content?, from_subagent?)** (front only): `canvases.create` (standalone, owned by the bot) with the markdown converted to canvas syntax (`<@U…>` → `![](@U…)`, `<#C…>` → `![](#C…)`, `<url|text>` → `[text](url)`) and group pings neutralised (also the canvas forms). Access via `canvases.access.set`: the current channel gets read (`channel_ids`), a group DM's members get read by user id (channel ids are invalid there), the speaker gets write. If `conversations.info` fails, the kind isn't guessed: the channel grant is tried, then member ids. Whenever the conversation's grant fails, the tool result tells the agent that others may have to request access (also when the speaker's grant worked). `from_subagent: "sa_…"` (also on `edit_canvas` append / replace_section / replace_all) takes the document from that subagent's latest complete run instead of `content`, which becomes an optional short intro (≤ 3000 chars): only subagents of the current thread, same conversion and ping neutralisation, cut at the write cap (100k chars) with a note. Synthesis turns' clipped results point at it. Recorded in `bot_canvases` (canvas, channel, thread, creator = speaker, turn, title, link). Idempotent per turn + title/content hash (DB row + Slack idempotency key), so a retried turn or a repeated call returns the same canvas. The tool leaves showing the link to the reply; a turn that created a canvas but posted no reply posts the link itself (from `bot_canvases.turn_id`) instead of the generic "couldn't come up with a reply" fallback.
- 
**edit_canvas(canvas, action, …)** (front only): only canvases in `bot_canvases`, and only when the speaker is their creator (the person who asked for them; others in the same channel can read but not edit it), so the bot can't be steered into editing anyone else's canvas. `append` (`insert_at_end`), `replace_all` (`replace` without section), `rename` (`title_content`), and `replace_section(heading, content)`: the canvas markdown is read, everything under the matching heading (up to the next heading of the same or higher level) is replaced, and the result is written back with `replace` (the whole document is converted and its group pings neutralised again, since the bot re-posts all of it; edits people make at the same moment can be lost, so the tool description prefers `append`). `canvases.sections.lookup` isn't used: a section id names a single block (a heading is its own section) and lookup can't list the blocks under a heading. Idempotent per turn + input hash. A canvas that no longer exists drops its row.
- 
Channel canvases (`conversations.canvases.create`) are not used: they change a channel's tab for everyone and a channel has only one.
- 
**Artifacts.** Slack Code (2026) shows agent "artifacts" (code diffs, Block Kit views, HTML previews, canvases) in code channels, but there is no documented public API for apps to publish them: docs.slack.dev has no artifact methods, the help article only says "Code channel APIs will be available to any developer", and code channels (`features.code_channels` manifest flag) appear limited to a list of partner agents for now (checked 2026-10). Artifacts in code channels are collected from what the agent shares there (canvases, files), so the canvases and file attachments above are what this bot publishes. Revisit when an API is documented.
- 
Retention: canvases are user deliverables and are never deleted from Slack. A `bot_canvases` row holds no content and is what keeps a canvas editable, so it outlives thread retention and is deleted after 180 days without use (create, read or edit).
### Agent sessions in DMs
Slack lists agent sessions (one per thread) in the user's sidebar with a title and a status. In DM threads with the bot (`threads.is_dm`, channel type `im`) the bot manages both (`src/pipeline/agent-session.ts`, table `agent_sessions`); channel threads keep the plain processing/active indicator and get no title.
-
**Titles.** The front agent gets `set_session_title` only in DM threads, and the turn prompt shows the current title in `<session>`. It titles a conversation on its first substantive turn (≤ 40 characters, one line, markup stripped) and retitles only when the topic clearly changes; at most one title per turn (idempotent). It uses `agents.sessions.rename` (`chat:write`); `agents.sessions.setStatus`'s `title` only applies when a session is created, which intake already did, so it is just the fallback for `session_not_found`.
-
**User renames win.** `agent_session_title_changed` with a human `user` stores the user's title; the bot never renames that session again (the tool says so). Events without a user, from the bot user, or repeating any title the bot set within two minutes (also an earlier one, delivered late) are treated as the echo of our rename. A user rename that lands while the bot's rename is in flight is re-applied afterwards, so Slack shows the user's title too.
-
**Statuses.** A DM turn ends `suspended` instead of `active` while a `send_message` or coding-agent launch confirmation from that thread is pending (Slack: "needs user clarification or a tool approval"); Send / Launch, Cancel or expiry set it `active` again (when they start a mention-like outcome turn, that turn sets `processing` and then its final status instead; a resume that finds the thread lock held keeps the session's note, which the 15 s sweep retries and the thread run re-checks after releasing the lock, so a silent outcome turn can't leave it `suspended`; expiry within ~15 s: a turn that ends `suspended` schedules the check for the confirmation's expiry; a click while the turn still holds the thread lock is re-checked when the lock is released). Side paths that clear a status (stop, intake, a batch that ends without a turn) restore this resting status (`suspended` / `closed`) instead of forcing `active`. `leave_thread` in a DM (DMs always reach the bot, so it doesn't disengage there) ends the turn `closed`: the conversation shows as done until the user writes again, which starts a normal turn (`processing`, then `active`). The prompt asks for it only when the user wraps up.
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
For more, the front agent can call `read_thread(before_ts, limit)` and `read_channel(before_ts, limit)` (current thread/channel only), or delegate a summary of a long thread to a subagent. The bot token only reads channels the bot is in. Other threads (e.g. a search hit that is a thread reply) are read with `read_public_thread(permalink | channel + thread_ts, limit?)`: user token (`channels:history` user scope), the channel must be verified public (cached `conversations.info`, fail closed), parent first then up to 50 replies, `##` messages dropped, forwarded content inlined, no image ids, counted as a Slack search.
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
A client tool, `web_search` (`src/tools/web-search.ts`), backed by Exa's search API (through Hack Club AI's Exa proxy first, then Exa direct with `EXA_API_KEY`), available to the front agent and subagents. (It replaced OpenRouter's `openrouter:web_search` server tool, which cost $0.01 per search plus the result tokens and couldn't be announced or rate-limited before running.) Parameters: `query`; `mode` = `fast` (default, Exa `instant`, ~0.5s, $0.004), `thorough` (Exa `auto`, $0.007) or, for subagents only, `deep` (Exa `deep-lite`, ~4s, $0.012); `num_results` (default 5, max 10); `include_domains`; `start_published_date` (news / "latest"); `full_text` (subagents only: capped page text instead of highlights). Results are numbered title / URL / published date / highlight, wrapped as untrusted content; their URLs feed `runs.sources`. Each call counts towards the per-user hourly web-search limit; failures and timeouts (10s, 25s for `deep`) come back as a short message.
### Semantic Slack search
`slack_semantic_search` (`src/tools/slack-semantic-search.ts`) is a secondary Slack search for both roles, backed by Slack's Real-time Search API (`assistant.search.context`): semantic (meaning-based) matching when the workspace has Slack AI Search and the query is a natural-language question, keyword matching otherwise (the tool says so, from a day-cached `assistant.search.info`). `slack_search` stays the primary search; the tool description and both prompts limit this one to cases where keyword searches failed or the question is conceptual ("who was organising…"). The front prompt allows one keyword search plus at most one semantic fallback before delegating (the tool itself allows 2 per turn); subagents use it once or twice per run. Enforced: at most 2 calls per front turn / subagent run, 20 per user per hour (guard `semantic_search`), and Slack's ~10/min user-level limit via the shared limiter, failing fast (`maxWaitMs`) with "use slack_search instead" rather than queueing. Token: the user token with the `search:read.public` user scope (a bot token would need the triggering event's short-lived `action_token`, which only mentions/DMs carry and later turns and subagent runs don't have). Privacy matches `slack_search`: `channel_types=public_channel`, messages only (no files/channels/users), every result's channel verified public via cached `conversations.info` (fail closed), `##` hits and context messages dropped, never any totals or cursors; results are mapped to the `search.messages` shape and formatted identically (channel mention, author, permalink, thread-reply marker, nearest two context messages per side). Slack forbids storing RTS data, so raw results are never persisted: subagent history compaction replaces them with a placeholder, and front turns keep no tool results at all. Text the agents derive from them (replies, subagent results in `runs.result`, canvases, memories) is ordinary output and persists like any other (retention applies).
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
`fetch_url` can't open Slack permalinks (they need auth); `read_public_thread` does that for public channels.
Fetched pages and search results are treated as untrusted data.
## Sending on behalf of users
`send_message(destination, text, files?)` can post to the thread's channel, another channel, or a DM. Anything sent outside the current thread is attributed to the requesting user and confirmed first.
**Confirmation (code-enforced).** Before sending outside the thread, the bot posts a `chat.postEphemeral` preview to the requester: destination, the message as it will appear, and Send / Cancel buttons. The pending send is stored server-side and expires after a few minutes; a stale click replies "This expired, ask again."
**The agent hears the outcome.** The tool returns "awaiting confirmation" and the turn normally just ends (the preview is visible, so no "check the preview" reply). Resolving the preview starts a front turn in the pending send's thread with the requester as speaker (`src/features/outcome-turn.ts`): the reused `scheduled` turn kind, whose stored input (`scheduled_turn_inputs`, `source = 'send'`, `source_ref` = the pending id) is a system notice with the destination, the outcome and the drafted message text quoted as untrusted reference material (the agent wrote it, possibly from untrusted sources, and an expired preview was never approved). Outcomes: **sent** (permalink, attachment upload failure if any), **not sent** (cancelled by the speaker, hourly limit, a definitive Slack error such as an archived channel), **expired**. A send-blocked requester gets no outcome turn: the ephemeral tells them privately, and the agent would announce the block in a possibly public thread. **A confirmation never depends on the model:** an outcome turn stores a code-written fallback (`scheduled_turn_inputs.fallback`, migration 181: "sent ✓ <link>", "not sent: <reason>"; none for cancel / expiry) that front.ts posts when the turn ends with nothing visible, fails or is stopped; outcome turns never get the generic "couldn't come up with a reply" / "Something broke" texts. A lost `ensureThreadRun` after the commit is covered by `recoverOrphanedTurns` (pending turns of any kind). Send / Cancel / failures are mention-like turns (status from the start, fallback text if the agent stays silent): the agent confirms in one short line with the link, or acknowledges. An expiry is a non-mention turn: the agent may stay silent, or add a short note. Exactly once per pending send: the status transition (`pending → cancelled/expired`, `sending → sent/cancelled`) and the turn insert commit in one transaction, so double clicks, retried jobs and expiry racing a click start one turn (a unique index on `(source, source_ref)` is the backstop). Entry checks (pause, channel disabled, suspension) and a gone thread (row deleted, root deleted) skip the turn quietly; the pending row still resolves. The expiry sweep runs every minute and only starts turns for previews that expired within the last hour; a click that crashed mid-send is settled by the sweep: sent if the message went out (`sent_messages` is written right after `chat.postMessage`, before uploads and the permalink; else the stored result of the post's idempotency key), otherwise "interrupted". Sweep outcomes are late, so non-mention turns, and there is none when the click path already showed "Sent ✓" itself (its outcome couldn't be recorded; a Redis marker tells the sweep).
**Previews after a click.** A successful Send deletes the ephemeral preview (`delete_original` on the interaction's `response_url`; ephemeral messages can't be deleted any other way) instead of replacing it with a confirmation: the agent's reply confirms it. If no outcome turn will run (skipped) or the delete fails, the preview becomes "Sent ✓ View message" as before. Definitive failures replace it with "Not sent: …"; unknown errors keep it with "Something broke… click Send again" (no outcome yet). Cancel keeps the short "Cancelled." replacement: instant feedback for the click while the agent's acknowledgement is a few seconds away.
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
- 
**Bot reports (`report_user`).** The front agent can quietly report the current speaker (no user id parameter, so it can't be steered into reporting someone else) for clear misuse: harassment or threats (incl. via `send_message`), scams, collecting personal info about others, impersonation, sexual content, deliberate abuse of the bot, or a genuine self-harm concern. Parameters: `category` (enum), `reason` (short, factual, ≤500 chars), optional `message_ts` (must be the speaker's own message; defaults to the turn's latest message). The mod channel gets the category, reason, a snapshot of the message (truncated, pings neutralised), permalinks to the message and thread, and admin-only buttons: Suspend user, Block from send tool, Mark reviewed, Dismiss. Nothing is shown in the user's thread and the bot never tells the user. Stored in `bot_reports` (pending → reviewed/dismissed); at most one per (user, thread) per hour and five per user per day, one per (thread, turn). Bot reports never count towards auto-suspension. Pending ones are kept until reviewed, handled ones go 30 days after review. App Home shows the pending count to the admin.
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
## Reminders and watches
Users can ask the bot to come back later (`src/features/schedule/`, tables in `120_reminders_watches.sql`). All six tools are front-only and take no user id: the owner is always the current speaker, and list/cancel only see the speaker's own items. Listing outside a DM hides the text of items created in other conversations.
- 
**Reminders.** `set_reminder(text, at | in)`: `at` is ISO-8601 (with an offset, or local wall time read in the speaker's Slack time zone, DST-correct), `in` a duration (`2h30m`, `3 days`, `PT2H`). Must be in the future and at most a year out; the tool result echoes the resolved time in the speaker's zone so the reply can confirm it ("ok, fri 9am"). The turn input already carries the speaker's local time. Caps: 20 pending per user.
- 
**Firing.** Postgres is the source of truth; a 1-minute maintenance task polls it (~1 minute precision; no delayed queue jobs to keep in sync with cancels, restarts or Redis loss). A poller claims one due row with `for update skip locked` (status `firing`, a claim id and a 5-minute lease), runs the entry checks and resolves the target, then inserts the turn and marks the row `fired` in one transaction that re-checks its claim: concurrent pollers or a crashed one never fire a row twice. The turn is a `scheduled` turn (kind `scheduled`, input in `scheduled_turn_inputs`) in the original thread with the owner as speaker, so the bot @mentions them in its own voice and can do any work the reminder asks for. At fire time: global pause, owner suspended or deactivated → skipped quietly (status `skipped` + reason). This is deliberate: the reminder is dropped, not postponed (a pause or suspension can last long, and a late reminder is mostly noise); the owner sees nothing. Channel disabled, bot removed from the channel or channel archived → the reminder still reaches the owner, in a DM thread (a one-shot reminder would otherwise be lost). Thread root deleted → the same DM fallback (rooted at a short bot note, idempotent per reminder). The entry checks run against the channel actually used, so a DM fallback is checked against the DM (e.g. a suspension hidden behind a disabled channel still skips it). Watches differ: a check in a disabled / left / archived channel is skipped with the baseline kept, and resumes when the channel is usable again. A thread row removed by retention is recreated. A failed attempt (Slack/DB error) is retried with backoff (1, 2, 5, 10 min; `retry_at`, so one blip can't burn every attempt at once); five failed attempts → `failed`, and the owner gets a short plain DM that the reminder couldn't be delivered (idempotent per reminder).
- 
**Watches.** `create_watch(source, target, criteria, check_every_hours?, expires_in_days?)` checks a web page (SSRF-safe fetch; normalized text snapshot + hash, line diff), a web search query (new result URLs) or a Slack search query (public channels only, verified and fail-closed, `##` dropped; only matches newer than the last seen ts, excluding the owner's own messages, bots and the watch's own thread) every 6 hours by default (min 1h). The baseline is taken at creation. When a background check finds candidate changes, a cheap no-tools Luna call (reasoning off, usage recorded for the owner) judges them against the owner's criteria; only a "yes" starts a `scheduled` turn in the watch's thread (not a mention: the agent may still stay silent) with the findings as untrusted data. At most one notification per check (unique per check number), at most 3 per watch per day (the baseline is kept while capped), entry checks every check, and every check counts against the owner's hourly fetch/search limits. Watches expire after 30 days at most (said when created); the snapshot is dropped as soon as a watch ends. Caps: 5 active per user.
- 
**App Home** lists the viewer's pending reminders and active watches with Cancel buttons. **Retention:** fired/skipped/cancelled reminders and ended watches (with their notifications) are deleted 30 days after they finish.
## Huddle DJ (HuddleFM)
The bot can DJ Slack huddles that run HuddleFM, through HuddleFM's bot API (https://github.com/ingoau/huddlefm/blob/main/docs/bot-api.md): JSON commands DMed to the HuddleFM user, replies threaded under them, events as DMs (`src/features/huddlefm/`, `190_huddlefm.sql`). Off unless `HUDDLEFM_USER_ID` is set; the bot's own user id must be in HuddleFM's `INTEGRATION_USER_IDS`. The feature follows gork's auto DJ (functionality only, own implementation) with these differences: all state lives in Postgres/Redis (any worker), song picks are verified, and the auto DJ learns from what people queue and skip.
- 
**Tools** (front only): `huddle_dj_mode(enabled, channel?, auto_dj?, chatter?, vibe?)` asks the host for control (`request_control` with add/add-bulk/remove-own/manage-queue/skip/pause/volume/clear; never end-session or settings) or releases it / cancels a pending request; `huddle_dj(channel?, commands[])` runs music commands in order (status, search, add by query/queries/reference with `play_next`, remove, move, shuffle, clear, skip with count, previous, pause, resume, seek, volume); `huddle_dj_settings(auto_dj?, vibe?, chatter?)`. The huddle is the current channel by default; another channel (or one named from a DM) needs the speaker to be a member (`conversations.members`, cached, fail closed). Anyone in the channel can use them once the host approved. `huddle_dj` calls count against a per-user hourly limit.
- 
**Transport.** Commands go through `slackCall` (idempotency keys from the turn/tool call or job) with Slack-proof JSON (`<`, `>`, `&`, `/` as JSON escapes). HuddleFM messages in the DM are routed by intake before anything else (never stored, never a conversation): replies land in Redis under the command's ts, and the sender polls that key, so no reply waiter lives in memory and a reply that beats `chat.postMessage` is simply already there. Work that waits on replies never runs in the slack-events processor (the replies come through it): it runs in the `huddlefm` queue.
- 
**Sessions.** One `dj_sessions` row per huddle channel: `pending` until the host answers (a silent request is dropped after 6 minutes), `active` after `grant_accepted`, deleted when DJ mode ends (turned off, declined, expired, revoked, `session.ended` / `session.suspended`, a lost-grant error, or an hour without any answer from HuddleFM). A request cancelled while pending is remembered, and a late approval of it is released right away.
- 
**Notices.** Things people should hear about (host answered, session ended or lost, a song someone queued failed to download, chatter) start an outcome-style `scheduled` front turn (source `huddlefm`) in the thread where DJ mode was asked for, with the requester as speaker and a `<huddle_dj_notice>` as input. The session update that makes it true is the transition, so a duplicate delivery announces once; grant and end notices have a code-written fallback. Chatter (off by default, at most one line per 4 minutes) and failure notices (at most one per 2 minutes) may stay silent.
- 
**Auto DJ** (on by default). Events, tool calls and a 1-minute sweep ask for a sync (a `huddlefm` job deduplicated per channel, at most one running plus one waiting). A sync reads `status`, stores the playback snapshot shown to the agent in `<huddle_dj>`, and when fewer than 2 songs people (or the bot) queued are waiting (HuddleFM's own autoplay picks don't count), asks Luna (low reasoning, structured output, usage recorded for the requester) for a few more candidates than needed, given the vibe, now playing, queue, recently played, songs people queued themselves, auto picks people skipped, its own recent picks and the origin thread's last messages (untrusted). Repeats are dropped in code, and each search result must match the title and artist with no unwanted variant (karaoke, cover, sped up…) or the candidate is skipped. A top-up that adds nothing backs off (1 min doubling to 15); a new vibe or turning auto DJ back on retries at once. Entry checks (pause, suspension, disabled channel) apply to the requester before any model call. The relevance gate is told when the bot is DJing in the thread's channel, so "skip this" reaches it.
## Coding agents (Cursor)
The bot's admin (`ADMIN_USER_ID`) can ask the bot to change its own code: a Cursor Cloud Agent works on the bot's repo and opens a PR (`src/agent/cursor/`, `160_cursor_agents.sql`). Off unless `CURSOR_API_KEY` and `CURSOR_REPO` are set (`CURSOR_REF` default `main`, optional `CURSOR_MODEL`). Uses Cursor's Cloud Agents API v1 (public beta; https://cursor.com/docs/cloud-agent/api/endpoints).
- 
**A subagent kind.** `subagents.kind = 'cursor'` plus the Cursor agent id; each run (card row) is backed by Cursor runs (`cursor_runs`). So a coding agent shows on the plan card like a subagent (details "Coding in Cursor…", the elapsed time, the Cursor agent and PR links as task sources), its result arrives through the same synthesis turn, and the front snapshot marks it `[coding agent, Cursor]`.
- 
**Tools.** `spawn_coding_agent(title, instructions)` (front only; only offered in the admin's own message turns). `message_subagent` / `cancel_subagent` dispatch on the kind. **Admin-only in code:** start, steer and cancel are refused unless the speaker is the admin and the feature is configured; bulk cancels by anyone else (old "Stop all" buttons) skip coding agents. Other users' messages never reach Cursor. The "Coding agents" prompt section is appended to the system prompt (after the shared, cacheable base) only in the admin's turns when the feature is configured; nobody else's turn learns the tool exists.
- 
**Prompt injection.** Everything a turn's model reads (thread history, other people's messages, fetched pages, search and subagent results, watch findings) can carry instructions, so: (1) starting, steering or resuming a coding agent is refused in code (`cursorInstructRefusal`, in the tool functions, not just the tool list) unless the turn is a `user` turn whose speaker is the admin. Synthesis turns (subagent results, which any thread participant can influence by steering the admin's model subagents) and scheduled turns (watch findings, reminders) can't, even though their author is the admin; cancelling stays allowed anywhere. (2) **Admin confirmation before launch:** `spawn_coding_agent` only proposes. The task goes into `pending_coding_agents` (15-min expiry) and the admin gets an ephemeral preview with the exact title and task as they will be sent (plain text, so formatting can't hide anything), the fixed rules code adds, and Launch / Cancel. Only `ADMIN_USER_ID` pressing Launch starts it (checked in the click handler); the claim is atomic (a double click launches once), the pending id doubles as the client-supplied Cursor agent id, stale clicks get a short reply, and the tool result tells the front agent the launch awaits confirmation. The launched agent gets a plan card of its own in the thread (no turn; synthesis goes to the admin). Follow-ups to an already-launched agent from the admin's own user turns need no button (the prompt says to pass only the admin's own words).
- 
**Instructions.** Code wraps the front agent's task in a fixed preamble: this repo is the bot, follow CLAUDE.md; never touch `.github/workflows/` or any other CI / repository-policy config (anything under `.github/`, other CI systems' files; also enforced on GitHub); the same agent may edit code or explore/search the codebase (no separate search kind); keep changes focused; run `pnpm typecheck` / `pnpm test` and a review subagent only when the agent judges them necessary (skip for README/docs-only or pure exploration); PR only (`autoCreatePR`), never push to the base branch or merge; end with a summary. Follow-ups restate the rules.
- 
**Steering.** Cursor can't inject a message into a running cloud run (create-run answers `409 agent_busy` while one is active; the SDK's `run.steer()` is local-only). A steer is queued in the subagent inbox (card note `↪ next: …`) and sent as a follow-up Cursor run (same conversation, branch and PR) as soon as the current run finishes; the card row stays running until Cursor is done. `message_subagent` on an idle coding agent starts a new run (↻) backed by a follow-up on the same Cursor agent.
- 
**Polling, exactly once.** No public HTTP endpoint (Socket Mode), so no webhooks: the `agent:cursor-poll` maintenance task (every 10 s) claims one due run at a time (`for update skip locked`, claim id + 10-minute lease renewed before slow steps, like reminders; finishing re-checks the claim inside `finishRun`'s transaction) and reads the Cursor run. Running → card details + next poll; finished with queued steers → follow-up run; FINISHED → result (PR link, branch, Cursor's summary) and `finishRun` → synthesis; ERROR / EXPIRED / cancelled elsewhere → error run. Creation is idempotent (client-supplied `bc-<uuid>` agent id; a retry gets `409 agent_id_conflict` and reuses the agent). Only a definite rejection (4xx other than 408) of a launch or follow-up deletes the local rows; on a timeout / network error / 5xx Cursor may have accepted it, so the rows stay and the poller looks the agent up (a follow-up records the previous run id, `after_run_id`, so it never adopts the old run; nothing new within 2 min → the run fails). A finish deferred for steers that arrived meanwhile is retried at most 3 times (`inbox_defers`), and a cancel-requested run always ends (cancel_subagent also drops unseen steers), so a run can't be re-polled forever. An agent that never gets a run times out like any other (`cursorRunMaxMs`). Nothing lives in worker memory, so restarts don't matter. Transient API errors back off (up to 5 min); a vanished agent fails the run.
- 
**Deleted thread root.** Cancelling a coding agent is the admin's call, so a deleted root doesn't cancel running ones (model subagents are cancelled as before). Instead they move to a DM thread with the admin (`rehomeCodingAgents`, from the intake's root-deleted handling): a short note roots the DM thread ("your coding agent '…' from a deleted thread continues here", idempotent per agent), and the subagent, its active run and a new plan card are re-homed there, so steering, cancelling and the result's synthesis turn all work in the DM. Idle ones stay where they were.
- 
**Timeouts.** The stale-heartbeat sweeper and shutdown hook skip coding agents (no worker loop); they have their own limit (`limits.cursorRunMaxMs`, 3 h): the Cursor run is cancelled and the run fails. At most `limits.cursorMaxActive` (3) run at once.
- 
**CI check.** The Cursor API doesn't list changed files, so after a run the PR's files are read from GitHub (REST "list pull request files", only for a PR in `CURSOR_REPO`; optional `CURSOR_GITHUB_TOKEN` for private repos). Any change to CI or repository-policy config (anything under `.github/`, e.g. workflows, actions, CODEOWNERS, dependabot.yml; CODEOWNERS elsewhere; other CI systems' config such as `.gitlab-ci.yml`, `.circleci/`, `.buildkite/`, `Jenkinsfile`, `.travis.yml`, `azure-pipelines.yml`) is flagged loudly in the result (card output "⚠️ touches CI config"); if the check fails, the result says so.
- 
**Results.** The synthesis turn shares the PR link and a short summary; the prompt says never to claim it's merged. Rows follow the subagent retention.
-
**Launch outcomes.** Like send_message previews (see Sending on behalf of users): Cancel, a failed launch (definite Cursor rejection, deleted thread) and expiry start one outcome turn for the admin (`source = 'coding_launch'`, a `<coding_agent_outcome>` system notice; expiry as a non-mention turn the agent may leave silent). A successful Launch has none (the plan card and the later synthesis cover it) and deletes the preview; it only turns into "Launched ✓ …" when the card couldn't be posted. Outcome turns are `scheduled` turns, so they can't start or steer coding agents.
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
~~Coding agents that open PRs.~~ Now implemented, admin-only: see Coding agents (Cursor).
- 
Memory extraction over workspace messages beyond conversations with the bot.
- 
Writing memory about other users.
### Open questions
- 
Does GPT-6 Luna via OpenRouter accept images in tool results, or is the user-message fallback needed?
- 
Does the AI SDK's OpenRouter provider pass `openrouter:*` server tool types through? (Yes; no longer used: web search is an Exa client tool.)
- 
Can a message be edited with `chat.update` after `stopStream`? (docs.slack.dev chat.update: only refused while streaming, `streaming_state_conflict`; editable once the stream completed.)
- 
Do `task_update` chunks render in a stream opened with nothing else, and does `chat.update` after `stopStream` drop them (activity cards)? Is the bot's activity message notified before it is adopted or deleted?
- 
Exact values for per-user limits and the auto-suspension report threshold.