# Code channels

A code channel is a Slack channel made for one session with the bot. The bot opens one for a task, or forks a
derailing thread into one. Top-level messages in the channel form a single conversation, and the bot answers
them without an @mention. Slack shows extra chrome around the conversation: a session status, view tabs, and
per-channel slash commands. A channel is archived when its work is done.

Status: built behind the `code_channels` kill switch (off by default). There is no plain-channel fallback: if
Slack refuses `agents.conversations.create` (`feature_disabled`, `user_not_enabled`), the tool and button
report that and nothing is created.

## Slack API (partner docs, read 2026-11-16)

The docs live at `api.slack.com/partners/code-channels` (plus `-lifecycle`, `-properties`, `-commands`,
`-changelog`, and `agent-conversations-*` method pages). They are only visible when signed in to a workspace
with partner access. `agents.sessions.*` is public at `docs.slack.dev/reference/methods/agents.sessions.*`.

- **Manifest:** `features.code_channels.enabled: true`. Socket Mode needs no `slash_command_url`.
- **Scopes:** `code_channels:manage` covers `agents.conversations.*`; `channels:manage` includes it.
  `chat:write` covers `agents.sessions.*`. Bot events: `agent_session_stopped` (formerly
  `message_stream_stopped`, which Slack fires as well while the rename rolls out). Messages arrive through the
  existing `message.channels` / `message.groups`; `message.session` restricts delivery to session channels.
  Each message is delivered once.
- **`agents.conversations.create`** `{ name (1–200, display name; Slack makes it unique), session_id? (≤64,
  idempotent), is_private?, origin_channel_id + origin_message_ts (together) }` → `{ channel_id }`. Only bot
  tokens are accepted, and the bot becomes the channel's agent.
  - With an origin link, Slack invites the origin message's author and lets origin-channel members join.
  - With an origin link and no `is_private`, privacy matches the origin.
  - Errors: `feature_disabled` (the app isn't a recognised agent app and the user doesn't have the feature),
    `user_not_enabled`, `invalid_origin_link`, `restricted_action`, `channel_not_viewable`,
    `channel_creation_failed`, `invite_failed`.
  - Tier 2.
- **`agents.conversations.archive`** `{ channel_id, summary_message_ts? }`. The agent bot or any member can
  call it. Archived channels stay searchable and can be reopened. Errors: `already_archived`,
  `not_agent_channel`, `not_authorized`, `restricted_action`. Tier 2.
- **`agents.conversations.setView`** `{ channel_id, type: html|diff|block_kit|canvas, view_key (1–256, upsert
  key; ignored for diff), content (html/diff, ≤1 MB), blocks (block_kit), canvas_id + access_level
  read|write|comment (canvas), name (tab label), csp.resource_domains (≤20 https origins) }`.
  - A channel holds at most 10 views, and at most 1 of them can be a diff.
  - HTML views must be complete, self-contained documents. They render sandboxed under a strict CSP.
  - Fails with `file_editing_disabled` when the org has disabled file editing. Canvas views still work then.
  - `listViews` / `removeView` manage existing tabs.
- **`agents.conversations.setCommands`** `{ channel_id, commands: [{ name (1–31, no slash), description
  (1–100), argument_hint? (≤50), should_escape? }] }` replaces the bot's whole command set for that channel.
  - A channel allows at most 10 commands across all agents.
  - An invocation arrives as a slash-command payload (Socket Mode `slash_commands` envelope).
- **`agents.conversations.setProperties`**: sets the context bar (≤5 items) and `pr_status`. It is not used in
  v1.
- **`agents.sessions.setStatus`** `{ channel_id, status: active|processing|suspended|closed }`. Omit
  `thread_ts` in a code channel; passing it fails with `thread_ts_not_allowed`.
  - `suspended` means the bot is waiting on a person.
  - `closed` doesn't archive the channel.
  - Channels start as `active`. Tier 3.
- **`agents.sessions.rename`** `{ channel_id, title (1–200) }` renames both the session and the channel.
  Errors: `is_archived`, `name_taken`. Tier 3.
- **Recognising a code channel:** `conversations.info` → `channel.properties.record_channel.record_type ===
  "agent_channel"`. `properties.agent_session.origin_link` is `{ channel_id, ts }`.
- **Stop:** `agent_session_stopped` `{ channel, thread_ts?, user, streaming_message_ts[] }`. Stop at once and
  make no further `agents.*` calls for that context.
- **Streaming:** `chat.startStream` without `thread_ts` posts a top-level streaming message.

## Behaviour

### Opening one
- **One tool, `open_code_channel({ name, brief?, fork?, members? , private? })`** (front only).
  - It is hidden inside code channels: no nesting.
  - It is also hidden when the `code_channels` kill switch is off.
  - The channel is named "smasnug ai: <name>".
  - There is no per-user cap.
- **Origin link:**
  - With `fork`, the origin is the latest user message in the current thread.
  - With a brief, the origin is the message that triggered the turn.
  - Slack invites the origin's author. `is_private` is omitted, so privacy follows the origin.
  - A DM origin always creates a private channel.
  - `private: true` makes a channel from a public origin private.
- **Invites:**
  - The agent may invite members of the origin conversation directly.
  - Anyone else needs a confirm button pressed by the requester, because they would see carried-over context.
  - When the origin is a DM, everyone invited needs that confirmation.
- **Fork:**
  - The bot writes a frozen summary of the source thread up to the fork point and posts it as the channel's first
    message ("Forked from <link>").
  - The latest user message is then answered in the channel.
  - The source thread gets a one-line link, and the current turn ends.
  - The source thread carries on as normal.
- **Brief:** the brief is posted as the first message. The bot runs one ordinary turn on it (which may spawn
  subagents or sandboxes), then waits for people.
- **The button:** the front agent can add a "Move to a code channel" action button (`move_to_code_channel`)
  to any reply when it judges the thread is drifting off topic, and may do so more than once per thread.
  - Anyone in the thread can press it.
  - The origin is the reply carrying the button, so the presser and the original requester are invited explicitly.
  - The seed is posted and the bot waits without starting a turn.
  - The reply's button area changes to "Moved → <link to the first message>".
- **Adoption:** a code channel created from Slack's own UI is adopted on the bot's first message event there.
  If it has an `origin_link`, it is treated as a fork of that message's thread.

### Inside the channel
- **Conversation:** top-level messages form one conversation, `threadId = ${channel}:0`.
  - The root `0` can't collide with a real message ts, so a Slack thread under any channel message (the seed
    included) keeps its own `${channel}:${thread_ts}` id.
  - Every place that turns a thread id back into a Slack `thread_ts` goes through one helper, which maps `0` to
    "no thread_ts".
  - `chat.startStream` also accepts `thread_ts: "0"` as top-level. `agents.sessions.setStatus` and `rename` must
    omit it.
  - The `code_channels` table records which channels are code channels. Intake checks it through a small cache.
  - Unmentioned top-level messages go through the relevance gate, with a code-channel hint ("assume it's for the
    bot unless it's side chatter or aimed at another person").
  - Unmentioned thread replies are ignored.
  - An @mention inside a thread is answered in that thread, with the channel conversation as context.
  - *Decision (stage 2):* a thread in a code channel follows the ordinary channel-thread rules. It is ignored
    until the bot is @mentioned in it; from then on it is an engaged thread like any other (unmentioned follow-ups
    go through the normal gate, and it disengages normally). The thread's context always includes the channel's
    conversation as background.
  - *Decision (stage 2):* an unmentioned top-level message that names someone else still goes to the gate (the
    code-channel note tells it to skip messages aimed at another person); a `<>` / `# ` message is still never
    answered without a mention. The gate uses the partner threshold there. Consent holds unmentioned top-level
    messages too, the same as a mention.
  - *Decision (stage 2):* adoption is checked only when the bot is @mentioned in a channel that isn't recorded
    (one cached `conversations.info`).
- **Replies:** posted top level (streamed without `thread_ts`).
- **Status:**
  - `processing` while a turn runs.
  - `active` when the turn ends.
  - `suspended` when the reply asked the user something, and while the archive warning is out.
    *Stage 2:* the conversation rests `suspended` while `threads.awaits_reply_from` is set (the reply ended with a
    question, an offer or buttons) or `warned_at` is set, until the next message. A native `agent_session_stopped`
    in a code channel makes no further `agents.*` calls (Slack settles the status); `!stop` still sets it.
  - Turns in a thread under a channel message don't set the session status (Slack refuses `thread_ts` there).
  - `closed` on archive.
- **`agent_session_stopped`:** stops the current turn, like `!stop`.
- **Views** (`set_view`, code channels only): canvas, HTML and Block Kit tabs, keyed by `view_key`. A canvas tab
  takes a canvas from `bot_canvases`.
- **Slash commands**, registered when the channel is created or adopted:
  - `/archive` (any member): posts a closing summary, reports to the parent, archives.
  - `/rename <title>`: calls `agents.sessions.rename`.
- **Source thread:** the agent can still read it under the private-link rules.

### Parent link
- **Ownership:** the thread that opened the channel is its parent. Its `code_channels` row links the two.
- **Updates:**
  - On archive, the closing summary is posted to the parent thread.
  - The channel's agent can post milestone updates there with `report_to_parent`.
- **Parent tools:**
  - `ask_code_channel(channel, question)`: a side query answered from the channel's conversation, summary and
    views. Nothing is posted in the channel.
  - `message_code_channel(channel, text)`: posts into the channel under a distinct identity
    (`chat:write.customize`, "smasnug ai · from <parent>"). The post is recorded as a parent-message event and
    starts a turn there as an instruction from the requester.
    - *Marker (stage 2):* message metadata `{ event_type: "smasnug_parent_message", event_payload: { parentThreadId,
      requesterId } }` (`src/features/code-channels/parent-message.ts`, `parentMessageMetadata`). Intake accepts it
      only from the bot's own bot_id, at the channel's top level, with `parentThreadId` equal to the row's
      `parent_thread_id`. It records a `parent_message` event and batches the post for the requester with reason
      `parent`, which skips the gate and counts as a mention. Every other bot post is stored and ignored.
  - `read_channel` also works on the channel.

### Lifecycle
- **Auto-archive:**
  - Day 6 with no messages: the bot posts a warning and sets the status to `suspended`.
  - Day 7: it posts a closing summary and calls `agents.conversations.archive` with that message's ts. The
    summary also goes to the parent thread.
  - Any message resets the clock.
- **Who can archive:** any member, with `/archive` or by asking the bot.
- **Reopening:** if someone reopens the channel and posts, the bot resumes with the stored context and the
  clock restarts.
- **Retention and withdrawal:** both cover `code_channels` rows and their seed summaries, the same as thread data.
