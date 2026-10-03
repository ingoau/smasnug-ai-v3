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
     (`/invite @Smasnug`).
   - `BOT_DISPLAY_NAME` — used in "Smasnug on behalf of …" attribution; keep it in sync with the bot's name.
5. Invite the bot to the channels where it should take part. Public channels can also receive on-behalf
   messages without an invite (`chat:write.public`); private channels need an invite.

After changing scopes or events in the manifest, reinstall the app (Slack shows a banner) so tokens pick up the new
scopes.

## Notes

- Socket Mode means no public URL: interactivity and the slash command arrive over the socket. No request URLs are
  needed in the manifest.
- The status indicator (`assistant.threads.setStatus`) uses `chat:write`. Slack still accepts `assistant:write` for it,
  but is moving it to `chat:write` only. `assistant:write` is left out because it would also need the Agents & AI Apps
  feature, which changes the DM UI.
- `/smasnug off|on|status` in a channel: only the channel's creator or the admin can toggle it.
