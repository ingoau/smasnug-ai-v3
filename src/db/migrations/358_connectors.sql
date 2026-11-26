-- MCP custom connectors (docs/mcp-custom-connectors.md): each user's permission settings per connector. The
-- connection itself (API key or OAuth state) is a vault credential of kind 'connector' named mcp.<slug>.
-- Modes: always_block | always_allow | auto (a verifier model checks the raw thread) | prompt (owner approves each call).

create table connector_settings (
  owner_id text not null,
  slug text not null,
  read_mode text not null default 'auto' check (read_mode in ('always_block', 'always_allow', 'auto', 'prompt')),
  write_mode text not null default 'prompt' check (write_mode in ('always_block', 'always_allow', 'auto', 'prompt')),
  delete_mode text not null default 'always_block' check (delete_mode in ('always_block', 'always_allow', 'auto', 'prompt')),
  -- Per-action overrides: [["<server tool name>", "<mode>"], …] (pairs, not an object: the db layer camelCases JSON
  -- object keys); a tool not listed uses its class's knob.
  overrides jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (owner_id, slug)
);
