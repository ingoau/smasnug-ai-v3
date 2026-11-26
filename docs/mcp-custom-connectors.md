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

## Custom connectors ("Add connector")

Besides the admin's catalog, anyone can add a remote MCP server of their own: App Home → Connectors → **Add connector**
(`src/features/connectors/custom.ts`, migration 359). The modal asks for a name, the server URL, an optional "what it
is for" (becomes the definition's description, which the agent sees), and how to sign in: **Sign in (OAuth)** or **API
key or token** with an optional header (empty = `Authorization: Bearer <key>`; another header gets the bare key).

- Validated like a catalog entry (`parseCatalog`: public `https://` URL without credentials or fragment, header
  name), and the egress pinning, SSRF checks, verifier, approval cards and scrubbing all apply unchanged.
- Stored per owner in `custom_connectors` with a slug `u-<name>-<4 random hex>` (max 24), never reused, so a removed
  connector's leftovers (cached tools, a connection whose delete failed) can't attach to one added later. Catalog entries can't use
  `u-` slugs (`loadCatalog` skips them with an error), so settings, connections (`mcp.<slug>`), grants and caches never
  collide with the catalog's. `enabledConnectors(ownerId)` / `enabledConnector(slug, ownerId)` return the enabled
  catalog definitions plus that user's own; nobody else ever sees or gets someone's custom connector.
- Same default modes as catalog connectors (read auto, write prompt, delete never).
- After **Add**, it goes straight on to connecting: the API key modal, or the OAuth sign-in DM.
- Up to 10 per person (`MAX_CUSTOM_CONNECTORS`; counted under a per-owner advisory lock). Each call re-reads the
  definition and refuses if its URL or auth type differs from the one the turn's tools were built from. **Remove** (confirm) deletes the connection, grants, settings,
  cached tools and the row; it works even while the feature is off.
- **Admin switch** (App Home, `connectors_custom_off` in `settings`): on by default. Off hides the Add button and makes
  every custom connector unusable (kept, back when it's on again). A failed settings read counts as off.
- Risk: the server is unvetted. Its tool descriptions and results are untrusted data like any connector's, and its tools
  load only on the owner's own turns, but the owner may be in a shared thread when they do.

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
  in App Home". A refresh runs under a per-connection Redis lock (`lock:conn:auth:<user>:<slug>`, taken when the auth
  flow starts, waited for up to 15 s); the flow first adopts tokens another worker stored meanwhile, and every write
  re-reads the stored secret and merges only its own change. After an `invalid_grant`, stored tokens are cleared only
  if they are still the ones that failed.
- The connection is one vault credential of kind `connector` named `mcp.<slug>`, meta `{ connector, auth, generation }`.
  The vault's own UI lists only tokens and logins, so it doesn't show there. `generation` is a new random id on every
  connect or replaced key (the credential row itself keeps its id): pending approvals carry it, and token writes from
  an older generation are dropped.
- **Disconnect** (and every connect / replaced key) aborts that connection's in-flight calls on every worker, deletes
  the user's `conn:<slug>:*` "allow for 10 min" grants and cancels their pending approval cards for that connector
  (`revokeConnection`). Disconnect also deletes the credential. Settings are kept for a later reconnect. Server-side
  tokens are not revoked (the user can revoke the app in the service).

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
- Input schema (`prepareInputSchema`): the server's JSON schema without `$schema` / `$id` / `$comment`, a top-level
  `$ref` into its own `$defs` resolved. Top-level `anyOf` / `oneOf` / `allOf` / `not` / `if` / `then` / `else` (which
  Anthropic's API refuses there) are dropped, the schema becomes `additionalProperties: true`, and the dropped rules
  are appended to the tool description (trimmed, untrusted). A non-object schema, one over 12 KB or an unresolvable
  `$ref` becomes a permissive object, again with the schema described in the description.
- At most `maxTools` per connector (default 25) and 60 per turn. Tool lists are cached in Redis per (user, connector)
  for 10 minutes (`conn:tools:<user>:<slug>`); connect, disconnect and settings changes invalidate it. A failed listing
  (10 s timeout) is remembered for 2 minutes (`conn:toolsfail:<user>:<slug>`) so a down server isn't retried every
  turn; App Home's *Edit actions* ignores that and retries.
- **Latency:** the listings start before the turn's context is built; once it is built, the turn waits at most
  `CONNECTOR_TOOLS_GRACE_MS` (1.5 s) more. A connector that isn't listed by then (or failed) sits the turn out: it's
  logged, the turn message gets one `<connector_note>` saying it was unavailable, and a listing still running finishes
  in the background and fills the cache for the next turn.
- Classification: the catalog's `tools` override, else MCP annotations (`readOnlyHint` → read, `destructiveHint` →
  delete), else write.

## Permissions

Three knobs (reading / changing / deleting) and four modes, resolved per (user, connector, tool): a per-action
override wins, else the knob for the tool's class. Stored in `connector_settings` (migration 358).

| Mode | Build | Execute |
|---|---|---|
| `always_block` ("Never") | omitted | refuse |
| `always_allow` | present | identity + limits + egress, then call |
| `auto` ("Auto-check") | present | verifier on the raw thread; if it doesn't approve, a warning card (as prompt) |
| `prompt` ("Ask me") | present (not in `!p` turns) | private approval card before the call |

Defaults: read = auto, write = prompt, delete = always_block. The mode is re-read at call time, so a change in App
Home applies even to a turn that already built its tools.

- **auto** (`verifier.ts`): the main prompt-injection defense. A second, cheap model judges the proposed call
  (connector, tool, description, arguments) against the **raw** recent thread (the last 15 stored Slack messages), not
  the agent's summary, and answers "did the owner themself ask for this exact action?". The transcript
  (`renderForVerifier`) is one JSON object per message (`{"n","from","owner","trigger","text","shared","files"}`), so
  newlines in a message can't forge another author's line; `owner` comes from the Slack user id (never a bot), and
  `trigger` marks the messages of the turn being answered. Only the owner's own messages can authorize; other people's
  messages, pasted/forwarded content, link previews, files, tool output and the bot's own messages don't count. Same stack as the relevance gate: OpenRouter's Decisions API with `GATE_MODEL`
  (probability ≥ 0.7 = yes; calibrated on real threads in `verifier.ts`), or the gate chat model (`MODEL_GATE`, must answer exactly YES) when `GATE_MODEL=luna`.
  **Fail closed:** an error, timeout or unclear answer refuses, with no fallback model. Usage is recorded per user.
  A refusal isn't a dead end: the owner gets the prompt-mode card with a warning ("the auto-check couldn't confirm
  that you asked for this…") and **Allow once / Deny** only (no grant key, so it neither uses nor creates a 10-minute
  grant). At most one such card per tool per turn (a second refused call of the same tool is just refused), and none in
  `!p` turns (refused, as there is nowhere to ask). The audit row records the refusal with `fallback: 'card'`. A turn that
  ends on such a card gets no "couldn't come up with a reply" fallback: the card answers the owner, and its outcome turn reports back.
- **prompt:** `requestApproval({ mode: 'outcome', kind: 'connector_call', grantKey: 'conn:<slug>:<tool>' })`. The
  owner sees the tool and **all** of its arguments on a private card (Allow once / Allow for 10 min in this thread /
  Deny). Arguments whose escaped preview doesn't fit the card in full (`ARGS_PREVIEW_MAX`, 2,600 characters) are
  refused before any card, with a note to the model: a cut preview would hide part of what runs. The agent's tool
  returns "awaiting approval" at once; on approval the executor makes the call in code and the result reaches the
  agent as an outcome turn. The approval payload holds the connection generation: if the connection was replaced or
  reconnected since, the executor refuses. Outcome turns aren't private, so prompt-mode tools are left out of `!p` turns.
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
- **Revocation:** a call snapshots a Redis counter per (user, connector) and per user (before it reads the connection)
  and polls it every second; disconnect, reconnect and privacy withdrawal bump it, so a call running on any worker
  aborts.
- **Audit:** every call (and refusal) goes to `vault_audit` with action `connector_call`, tool `<slug>:<tool>`, mode
  and outcome, never the arguments. Users see recent uses in App Home's vault section.
- **Untrusted results:** only text items and text resources are kept (images, audio and binary resources are counted),
  structured content when there is no text; capped at 20,000 characters, scrubbed of the connection's key / tokens
  (`scrubText`) and wrapped with `untrusted()`. So is the server's error text (JSON-RPC errors, HTTP bodies) when a
  call fails.
- **Privacy withdrawal** (`handlePrivacyWithdraw`): `deleteAllVaultData` removes the connections and audit rows;
  `deleteConnectorData` removes their `connector_settings`, cached tool lists, and aborts their in-flight calls.

## App Home

- **Connectors** (after the vault section): each enabled definition with Connect / Disconnect. A pending OAuth
  connect shows *Open sign-in page* and *Paste code*. Connected: three selects (Reading / Changing / Deleting) and
  *Edit actions*, a modal with one select per server tool (Default or a mode). The modal opens with "Loading…" and is
  filled in with `views.update`, because listing tools can take longer than a trigger id lives (3 s).
- Up to 10 catalog connectors, then all of the user's own, which carry "added by you · <host>" and a **Remove** button
  (deleting the connection by name, even if it can't be decrypted); **Add connector** comes last
  (while the admin allows it and the user has fewer than 10).
- **Admin:** the "Add connector" switch, catalog file status, skipped entries, and Enable / Disable per definition.
- Action ids use the `conn:` prefix, modals `connm:` (sealed in transit). Modal errors reopen the modal with the
  submission's trigger id, else DM.

## Not in v1

Subagents (children) using connectors; reminders / watches calling them; per-workspace catalogs (no team id);
server-initiated notifications and sampling/elicitation; stdio servers; servers without any auth (custom connectors
need OAuth or a key); revoking tokens at the server on disconnect;
pagination of very large tool lists (first page only).

## Tests

- `src/features/connectors/logic.test.ts`: catalog parsing, classification, mode resolution, tool-name sanitizing,
  origin pinning, OAuth paste blob, verifier answers and transcript (a forged owner line stays its author's), result
  rendering, schema preparation (top-level combinators, `$ref`).
- `src/features/connectors/connectors.int.test.ts` (`INTEGRATION=1`): an in-process MCP server on 127.0.0.1 with the
  real vault, Postgres and Redis: build-time filtering by identity and mode, always_allow / auto / prompt, scrubbing,
  mode changes after build, abort on disconnect, over-long prompt arguments, untrusted server errors, reconnect
  (grants, pending cards, generation check), the OAuth refresh lock and merge, the failure cache and the turn's wait
  cap, egress pinning.
