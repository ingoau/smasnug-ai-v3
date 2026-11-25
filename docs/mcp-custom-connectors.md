# MCP custom connectors

A user connects a remote MCP server (Todoist, Fastmail, Twenty, …) with **their own** credentials. The front agent
then gets that server's tools, but only on that user's own turns, and every action goes through a permission mode.
One shared bot process serves many users; a credential never leaves its owner.

Code: `src/features/connectors/` (GitHub issue #62). Built on the vault (`src/features/vault/`): connections are vault
credentials, prompt-mode approvals are vault approval cards, every call lands in the vault audit log.

## Operator setup

1. **Vault key.** Set `VAULT_SECRET_KEY` (`openssl rand -base64 32`). Without it the whole feature is off: no App Home
   section, no tools.
2. **Catalog.** Write the connector definitions to a JSON file (start from `connectors.example.json`) and point
   `CONNECTORS_FILE` at it (default `connectors.json` in the working directory; in Docker, mount the file and set the
   path). `connectors.json` is git-ignored. A missing file is an empty catalog. The file is re-read when it changes
   (checked every few seconds); invalid entries are skipped and listed in App Home.
3. **Enable.** In App Home the admin (`ADMIN_USER_ID`) sees *Connectors catalog*: the file's status and an
   Enable / Disable button per definition (stored as `connector_enabled:<slug>` in `settings`). New definitions start
   disabled. Disabling hides the connector and refuses calls at once; users' connections are kept.
4. **OAuth (only for `"type": "oauth"` connectors).** Host `oauth/index.html` on any static https host (GitHub Pages,
   Cloudflare Pages, an S3 bucket…) and set `MCP_OAUTH_REDIRECT_URL` to its exact URL. That URL is the redirect URI the
   bot registers with each server (dynamic client registration). The page never sends anything anywhere: it reads
   `?code` / `?state` from its own URL, clears them from the address bar and shows one string, `<state>.<code>`, for the
   user to paste back into Slack. The code is single-use and worthless without the PKCE verifier only the bot holds.
   Without `MCP_OAUTH_REDIRECT_URL`, OAuth connectors show "sign-in isn't set up" and API-key ones still work.

### Definition

```json
{
  "slug": "todoist",                 // [a-z0-9] with single dashes, ≤ 24; tool names become todoist__<tool>
  "name": "Todoist",
  "description": "Your Todoist tasks.",
  "url": "https://ai.todoist.net/mcp", // remote Streamable HTTP endpoint, public https only
  "auth": { "type": "oauth", "scopes": ["data:read_write"] },
  // or { "type": "api_key", "header": "X-Api-Key", "scheme": "", "help": "Where to create a key…" }
  //    (default header Authorization with scheme Bearer)
  "tools": { "find_records": "read", "delete_records": "delete" }, // optional class overrides
  "maxTools": 25                     // optional, 1–60 (default 25)
}
```

There are no user-pasted URLs: only the admin decides which servers exist. Only remote HTTP servers (no stdio).

## Connecting (App Home → Connectors)

Any user who agreed to the privacy policy can connect an enabled connector.

- **API key:** *Connect* opens a modal (`connm:key`; the submission is sealed in transit like vault modals). The key is
  checked with a `tools/list` call before it's stored.
- **OAuth:** *Connect* runs `auth()` from `@ai-sdk/mcp` with a vault-backed `OAuthClientProvider`
  (`connection.ts`): protected-resource and authorization-server discovery, dynamic client registration, PKCE and a
  random state, all kept in the user's vault credential. The sign-in link comes by DM (and stays in App Home for 30
  minutes) with a *Paste code* button. The user approves, copies `<state>.<code>` from the static page, presses
  *Paste code* and pastes it (`connm:code`). The bot checks the state, exchanges the code and stores the tokens.
  Tokens refresh through the same provider on later calls; if a refresh needs a new sign-in, the call says "reconnect
  in App Home".
- The connection is one vault credential of kind `connector` named `mcp.<slug>`, meta `{ connector, auth }`. The
  vault's own UI lists only tokens and logins, so it doesn't show there.
- **Disconnect** deletes the credential and aborts that connection's in-flight calls on every worker. Settings are
  kept for a later reconnect. Server-side tokens are not revoked (the user can revoke the app in the service).

## Identity

Connector tools are added in `src/agent/front.ts` right after `toolsFor('front', …)`, by `loadConnectorTools`:

- only on front-agent turns with `turn.kind === 'user'`, for the turn's `authorId` (= the speaker). Never for subagents
  (v1), reminders, outcome turns or synthesis turns;
- filtered at build time: no connection → no tools; a tool whose mode is `always_block` isn't in the map at all;
- in mixed-author threads, Alice's connectors exist only on Alice's turns;
- built-in tool names are never shadowed.

## Tools

- Name `<slug>__<tool>`, sanitized to `[a-zA-Z0-9_-]`, ≤ 64 characters, unique (`_2`, `_3`…).
- Description: the connector name, whose account it is, the action class and how the mode behaves, then the server's
  own description (untrusted: control characters stripped, capped).
- Input schema: the server's JSON schema if it is an object schema under 12 KB, else a permissive object.
- At most `maxTools` per connector (default 25) and 60 per turn. Tool lists are cached in Redis per (user, connector)
  for 10 minutes (`conn:tools:<user>:<slug>`); connect, disconnect and settings changes invalidate it. A server that
  can't be listed (10 s timeout) just contributes no tools that turn.
- Classification: the catalog's `tools` override, else MCP annotations (`readOnlyHint` → read, `destructiveHint` →
  delete), else write.

## Permissions

Three knobs (reading / changing / deleting) and four modes, resolved per (user, connector, tool): a per-action
override wins, else the knob for the tool's class. Stored in `connector_settings` (migration 358).

| Mode | Build | Execute |
|---|---|---|
| `always_block` ("Never") | omitted | refuse |
| `always_allow` | present | identity + limits + egress, then call |
| `auto` ("Auto-check") | present | verifier on the raw thread; refuse unless it approves |
| `prompt` ("Ask me") | present (not in `!p` turns) | private approval card before the call |

Defaults: read = auto, write = prompt, delete = always_block. The mode is re-read at call time, so a change in App
Home applies even to a turn that already built its tools.

- **auto** (`verifier.ts`): the main prompt-injection defense. A second, cheap model judges the proposed call
  (connector, tool, description, arguments) against the **raw** recent thread (the last 15 stored Slack messages,
  rendered like the relevance gate's input), not the agent's summary, and answers "did the owner themself ask for this
  exact action?". Other people's messages, pasted/forwarded content, link previews, files, tool output and the bot's
  own messages don't count. Same stack as the relevance gate: OpenRouter's Decisions API with `GATE_MODEL`
  (probability ≥ 0.8 = yes), or the gate chat model (`MODEL_GATE`, must answer exactly YES) when `GATE_MODEL=luna`.
  **Fail closed:** an error, timeout or unclear answer refuses, with no fallback model. Usage is recorded per user.
- **prompt:** `requestApproval({ mode: 'outcome', kind: 'connector_call', grantKey: 'conn:<slug>:<tool>' })`. The
  owner sees the tool and its arguments on a private card (Allow once / Allow for 10 min in this thread / Deny). The
  agent's tool returns "awaiting approval" at once; on approval the executor makes the call in code and the result
  reaches the agent as an outcome turn. Outcome turns aren't private, so prompt-mode tools are left out of `!p` turns.
- **always_allow:** calls directly. Writes are not forced to prompt. **Risk:** anything that can steer the agent in a
  turn where the owner is the speaker (a pasted document, a web page it read, another person's message in the same
  thread) can then make it act on the owner's account without a check. App Home says what each mode does; prefer
  Auto-check or Ask me for writes in shared channels.

## Shared-process controls

- **Origin-pinned egress** (`egress.ts`): the MCP transport and the OAuth helper get a custom `fetch` over `safeFetch`
  (SSRF-safe: private and local addresses refused at connect time, DNS rebinding included). It refuses any origin other
  than the definition URL's, except the authorization-server / token-endpoint origins recorded while connecting
  (needed for refreshes). While connecting, any public https origin is allowed (discovery may point anywhere) and
  recorded. No redirects are followed; responses over 4 MB fail. The long-lived server→client SSE stream (GET) is
  answered 405 locally: only request/response calls are made.
- **Timeouts:** 10 s for listing tools, 30 s per call.
- **Limits:** every call takes one `credential_use` (shared with the vault's credential uses).
- **Revocation:** a call snapshots a Redis counter per (user, connector) and per user and polls it every second;
  disconnect, reconnect and privacy withdrawal bump it, so a call running on any worker aborts.
- **Audit:** every call (and refusal) goes to `vault_audit` with action `connector_call`, tool `<slug>:<tool>`, mode
  and outcome, never the arguments. Users see recent uses in App Home's vault section.
- **Untrusted results:** only text items and text resources are kept (images, audio and binary resources are counted),
  structured content when there is no text; capped at 20,000 characters, scrubbed of the connection's key / tokens
  (`scrubText`) and wrapped with `untrusted()`.
- **Privacy withdrawal** (`handlePrivacyWithdraw`): `deleteAllVaultData` removes the connections and audit rows;
  `deleteConnectorData` removes their `connector_settings`, cached tool lists, and aborts their in-flight calls.

## App Home

- **Connectors** (after the vault section): each enabled definition with Connect / Disconnect. A pending OAuth
  connect shows *Open sign-in page* and *Paste code*. Connected: three selects (Reading / Changing / Deleting) and
  *Edit actions*, a modal with one select per server tool (Default or a mode). The modal opens with "Loading…" and is
  filled in with `views.update`, because listing tools can take longer than a trigger id lives (3 s).
- **Admin:** catalog file status, skipped entries, and Enable / Disable per definition.
- Action ids use the `conn:` prefix, modals `connm:` (sealed in transit). Modal errors reopen the modal with the
  submission's trigger id, else DM.

## Not in v1

Subagents (children) using connectors; reminders / watches calling them; per-workspace catalogs (no team id);
server-initiated notifications and sampling/elicitation; stdio servers; revoking tokens at the server on disconnect;
pagination of very large tool lists (first page only).

## Tests

- `src/features/connectors/logic.test.ts`: catalog parsing, classification, mode resolution, tool-name sanitizing,
  origin pinning, OAuth paste blob, verifier answers, result rendering, schema sanitizing.
- `src/features/connectors/connectors.int.test.ts` (`INTEGRATION=1`): an in-process MCP server on 127.0.0.1 with the
  real vault, Postgres and Redis: build-time filtering by identity and mode, always_allow / auto / prompt, scrubbing,
  mode changes after build, abort on disconnect, egress pinning.
