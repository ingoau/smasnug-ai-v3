# Slack app setup

Use a separate app in a test workspace for development.

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest**, pick the workspace and paste
   `slack-manifest.yml`. Review and create.
2. **Basic Information → App-Level Tokens → Generate Token and Scopes**: add the `connections:write` scope (Socket
   Mode needs it). The `xapp-…` token is `SLACK_APP_TOKEN`.
3. **Install App** → install to the workspace. Copy:
   - **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`
   - **User OAuth Token** (`xoxp-…`, has `search:read`) → `SLACK_USER_TOKEN`. It searches as the installing user;
     code restricts results to public channels.
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
  `active` when it ends (always, also on errors — unlike the old `assistant.threads.setStatus` it does not clear
  itself when the bot posts). If it fails unexpectedly, the bot falls back to `assistant.threads.setStatus` once.
- **Native stop button**: while a session is `processing`, Slack shows a stop button (because the app subscribes to
  `agent_session_stopped`). Clicking it behaves like saying "stop": the running turn ends at its next step, active
  subagent runs in the thread are cancelled, the user's queued turns are dropped, the thread disengages, and the bot
  confirms with "Stopped.".
- `agent_session_title_changed` is only logged.
- `/smasnug off|on|status` in a channel: only the channel's creator or the admin can toggle it.
