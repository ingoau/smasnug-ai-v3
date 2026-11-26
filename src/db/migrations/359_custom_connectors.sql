-- Connectors people add themselves (App Home "Add connector", docs/mcp-custom-connectors.md "Custom connectors"):
-- one MCP server definition per row, visible and usable only by its owner. The slug always starts with 'u-' (catalog
-- slugs can't), so settings, connections (vault credential mcp.<slug>) and caches never collide with the catalog's.

create table custom_connectors (
  owner_id text not null,
  slug text not null check (slug like 'u-%'),
  name text not null,
  description text not null default '',
  url text not null,
  auth_type text not null check (auth_type in ('oauth', 'api_key')),
  key_header text,
  key_scheme text,
  created_at timestamptz not null default now(),
  primary key (owner_id, slug)
);
