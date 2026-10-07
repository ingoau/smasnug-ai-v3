# Slack app setup

Use a separate app in a test workspace for development.

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**, pick the workspace and paste
   `slack-manifest.yml`. Review and create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the `connections:write` scope (Socket
   Mode needs it). The `xapp-…` token is `SLACK_APP_TOKEN`.
3. **Install App** → install to the workspace. Copy:
   - **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
   - **User OAuth Token** (`xoxp-…`, has `search:read` and `channels:history`) → `SLACK_USER_TOKEN`. It searches as
     the installing user; code restricts results to public channels. `channels:history` is used by
     `read_public_thread` (public-channel threads found via search, also in channels the bot isn't in) and
     `read_public_channel` (top-level history / surrounding context in any public channel); the channel is verified
     public via `conversations.info` first. Without that scope those tools tell the model they can't open other
     channels/threads yet. `search:read.public` is used only by `slack_semantic_search` (Slack's
     Real-time Search API, public channels only); without it that tool tells the model to use `slack_search`.
4. Fill in the rest of `.env`:
   - `ADMIN_USER_ID` — your Slack user id (profile → ⋯ → Copy member ID). The admin approves workspace facts,
     handles reports, can pause the bot from App Home and bypasses pause/suspension.
   - `MOD_CHANNEL_ID` — a private channel for reports and workspace-fact approvals. Invite the bot to it
     (`/invite @smasnug ai v3`).
   - `BOT_DISPLAY_NAME` — used in "smasnug ai v3 on behalf of …" attribution; keep it in sync with the bot's name.
5. Invite the bot to the channels where it should take part. Public channels can also receive on-behalf
   messages without an invite (`chat:write.public`); private channels need an invite.

After changing scopes or events in the manifest, reinstall the app (Slack shows a banner) so tokens pick up the new
scopes.

## Notes

- Socket Mode means no public URL: interactivity and the slash command arrive over the socket. No request URLs are
  needed in the manifest.
- **Agents & AI Apps** is on (`features.agent_view` + `assistant:write`). Users get smasnug ai v3 in the agent container:
  a split view that stays open next to whatever channel they are looking at, with the suggested prompts from the
  manifest. While the container is open Slack sends `app_context_changed` with the channel the user is viewing; the
  bot remembers it for a few minutes and tells the front agent on that user's next DM turn ("User is currently
  viewing #…"), so "summarise this channel" works. Mentions in channel threads work as before.
- The status indicator uses `agents.sessions.setStatus` (`chat:write`): `processing` while a mention/DM turn runs,
  `active` when it ends (always, also on errors: it does not clear itself when the bot posts). The deprecated
  `assistant.threads.*` methods are not used. Tool activity ("Searching Slack…") shows as transient task cards in the
  reply message (`STATUS_ACTIVITY_MODE`, see docs/design.md "Status indicator").
- **No native stop button**: the app deliberately does not subscribe to `agent_session_stopped` (people clicked the
  button by accident), so Slack shows a non-interactive loading indicator while a session is `processing`, and
  `agents.sessions.setStatus` / streaming calls answer with a `missing_agent_session_stopped_event_subscription`
  warning, which the Slack client logs only at debug level. `@bot !stop` (anyone; in DMs the mention is optional)
  stops the current response: the running turn ends at its next step, the user's queued turns are dropped, and the
  bot confirms with "Stopped.".
- DM threads get a session title (`agents.sessions.rename`, `chat:write`) and end `suspended` / `closed` where it
  fits (docs/design.md "Agent sessions in DMs"). `agent_session_title_changed` records a user's rename so the bot
  never overwrites it.
- `/smasnug off|on|status` in a channel: only the channel's creator or the admin can toggle it.
- **Canvases** need the bot scopes `canvases:read` (`read_canvas`) and `canvases:write` (`create_canvas` /
  `edit_canvas`, sharing via `canvases.access.set`), both in the manifest; an app installed before they were added
  must be reinstalled to get them (until then the tools tell the model canvases aren't enabled). Creating standalone
  canvases needs a paid Slack plan: on a free workspace `canvases.create` fails
  (`free_teams_cannot_create_standalone_canvases`) and the bot answers in the thread instead (a `.md` file for long
  content).

- **HuddleFM DJ mode** (optional): set `HUDDLEFM_USER_ID` to the HuddleFM bot user's id, and add this app's bot user
  id to HuddleFM's `INTEGRATION_USER_IDS` (HuddleFM ignores everyone else). It uses scopes the manifest already has:
  `im:write` (open the DM with HuddleFM), `chat:write`, `im:history` + the `message.im` event (HuddleFM's replies and
  events), `channels:read` / `groups:read` (membership check when someone controls a huddle in another channel).
  Grants don't survive a HuddleFM restart: the bot notices (lost-grant error or no answer) and says DJ mode is off.

## Dev and production apps (Hack Club workspace)

- **smasnug ai v3** (`A0C6K5WK0KW`) — production, created from `slack-manifest.yml` as-is.
- **dev - smasnug ai v3** (`A0C6FBD1KL2`) — development; same manifest with `name`/`display_name` set to
  `dev - smasnug ai v3` / `dev - smasnug ai` and the slash command renamed to `/smasnug-dev` (so both can be installed side by side; the
  code matches `slash:/smasnug*` by prefix). Local `.env` uses this app's tokens and `BOT_DISPLAY_NAME=dev - smasnug ai`.

Installing into Hack Club needs workspace-admin approval ("Request to Workspace Install").
- **Reactions**: the app subscribes to `reaction_added` / `reaction_removed` (scope `reactions:read`). For messages the
  bot stores (threads it takes part in, plus channel context), reactions are kept in `messages.reactions` and shown
  to the front agent at the end of each line (`[reactions: :+1: ×2 (Ingo, Sam), :eyes: (you)]`). Reactions never
  start a turn. The bot can add (`react`) and remove its own (`unreact`) reactions (`reactions:write`).
