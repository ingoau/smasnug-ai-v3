# Custom emoji tools

Two tools, both in the tools module. Design notes are in `docs/design.md` ("Reactions and emoji").

## download_emoji (always on)

Uses the bot token's `emoji:read` scope (already in `slack-manifest.yml`). It needs no extra setup.

## upload_emoji (optional)

Slack has no app-token API for adding a custom emoji outside Enterprise Grid (`admin.emoji.add` needs an org admin's
`xoxp-` token with `admin.teams:write`). So `upload_emoji` calls `emoji.add` the way Slack's web client does, as a
logged-in user (the "userbot"). It only exists when these are set:

| Variable | Value |
|---|---|
| `SLACK_USERBOT_TOKEN` | The session's `xoxc-…` token. |
| `SLACK_USERBOT_COOKIE` | The value of that session's `d` cookie (`xoxd-…`), URL-encoded or not. |
| `SLACK_USERBOT_API_URL` | Optional. API base, e.g. `https://hackclub.slack.com/api/`. Default: the session's workspace URL from `auth.test`. |

Which session to use:

- **Normal workspace:** a session for that workspace, from an account that is allowed to add custom emoji
  (workspace settings can restrict this to admins).
- **Enterprise Grid:** a session from the org's sign-in works too. Calls carry `slack_route=<enterprise_id>:<team_id>`
  for the bot's workspace, like the web client. Custom emoji are org-wide there.

Use a dedicated account if you can. Emoji added through the bot show that account as the uploader. The session
dies if the account logs out or Slack ends it; uploads then answer "The userbot session was rejected" until the
values are replaced. Keep both values secret: together they act as that account for anything it can do in Slack.

`emoji.add` is an undocumented, internal method, so Slack can change or block it at any time.
