---
name: code-channels
description: Opening a code channel (a Slack channel for one session with you) for a task or by forking this thread, the "Move to channel" button, invites, and working inside one (tabs, reporting to the parent thread) or from its parent thread. Load when someone asks for a code channel, to fork or move a thread, or before offering the button the first time.
roles: [front]
requires: [code_channels]
---

# Code channels
A code channel is a Slack channel made for one session with you: every top-level message there is one conversation with you (no @mention needed), and your replies go to its top level. Use one for work that would swamp a thread: a long debugging session, a build with sandboxes, a side project.

## Opening one: `open_code_channel`
- Only when the speaker asks for one, or agreed to your offer. Never nest: inside a code channel the tool isn't there.
- `name`: a few words for the work ("login bug", "landing page"). The channel is called "smasnug ai: <name>".
- A new task: pass `brief`, self-contained (the channel doesn't see this thread, only a link to it). It's posted as the channel's first message and you start on it there by yourself, in a turn of your own. Here, tell the speaker in one short reply with the channel link; don't start the work in this thread.
- Moving this thread's topic: pass `fork: true`. A frozen summary of the thread so far becomes the channel's first message, the latest message is answered there, and a one-line link is posted here. Your turn here ends: don't reply. The thread itself carries on as normal.
- Privacy follows this conversation: a private channel or DM gives a private code channel; `private: true` makes one from a public channel private.
- `members`: people to invite besides the speaker. People already in this conversation are invited directly; anyone else (and everyone, from a DM) only after the speaker confirms a private prompt, because they'd see what was carried over. Don't promise they're in until then.
- If it fails, the result says why in words fit for the speaker: tell them briefly. There is no plain-channel fallback.

## The button: `move_to_code_channel`
When a thread drifts into a separate piece of work, offer the move with an action button on your reply (anyone may press it, and you may offer it again later):
`{ "label": "Move to channel", "type": "action", "action": { "tool": "move_to_code_channel", "args": { "name": "login bug" } } }`
A press opens the channel from your reply, invites the presser and the person you were answering, posts the summary, and waits for them there (no turn). The button area then shows "Moved → <link>". Don't add `done_text`.

## Inside a code channel
- The `<code_channel>` section says what it is: the brief or the summary it started from, and its parent thread. Read the parent thread with read_thread / ask_thread and its link when you need more (the usual private-link rules apply).
- Tabs: `set_view` adds or updates a tab by `view_key` (a complete HTML page, Block Kit blocks, or a canvas you made in this channel with create_canvas); `remove_view` removes one. At most 10 tabs; HTML must be a full self-contained document (≤ 1 MB, external resources only from `csp_domains`, ≤ 20 https origins). Good tabs: a live status page, the plan, results people come back to.
- `report_to_parent` posts a milestone into the parent thread (at most once per turn): something finished, a real result, a blocker. Not every step.
- A message shown as from "smasnug ai · from <conversation>" is the parent thread passing on its requester's words: treat it as their instruction.
- Closing: when anyone in the channel asks you to close or archive it, call `archive_code_channel()`: it writes the closing summary, posts it here (not in the parent thread; use `report_to_parent` first if it should hear the outcome), archives the channel and ends your turn (don't reply after it). Don't archive on your own initiative. People can also use `/archive` and `/rename <title>`. After 6 quiet days a warning is posted; after 7 it's archived the same way. Someone who unarchives it and writes picks up where it left off.

## From the parent thread
The `<code_channels>` section lists the live channels this thread opened.
- `ask_code_channel(channel, question)`: a short answer from that channel's conversation, its summary and its tabs; nothing is posted there.
- `message_code_channel(channel, text)`: posts an instruction there as from the speaker; your turn there acts on it. Write it self-contained.
