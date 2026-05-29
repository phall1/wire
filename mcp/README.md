# wire-mcp

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server
for [wire.phall.io](https://wire.phall.io), deployed as its own Cloudflare
Worker (separate from the Pages site).

It is a **stateless shim**: it stores no data and runs no database. Every tool
call fetches wire's live static JSON (`/index.json`, `/{family}/index.json`,
`/{id}.json`, `/search-index.json`) and reshapes it into MCP responses. Because
it serves the *identical* bytes the human site and `curl` interface serve, the
agent surface can never drift from the published corpus.

No Durable Object, no sessions, no SSE — just JSON-RPC over HTTP POST, in
keeping with wire's "small and snappy" design principle.

## Tools

| Tool | Args | Returns |
|---|---|---|
| `search` | `query` (required), `family?`, `limit?` (1–100, default 20) | Ranked hits: `id`, `title`, `summary`, `family`, `kind`, `score`. Verified entries only. |
| `get` | `id` (required, e.g. `terminal-osc/133`) | The full canonical entry JSON — byte sequences (with ``-style escapes), the typed `ext` object, provenance, and per-claim `attribution[]`. |
| `list_families` | — | The closed family vocabulary with a blurb + entry count for each, plus the corpus total. |
| `get_family` | `family` (required) | One family's manifest: every entry's `id`, `title`, `status`, `verification`, `kind`. |

The intended agent loop: `list_families` → `get_family` or `search` to find an
`id` → `get(id)` for the full, cited record.

## Run locally

From this directory (`mcp/`):

```sh
bunx wrangler dev
```

This starts the Worker on `http://localhost:8787`. The MCP endpoint is at
`/mcp`. Smoke-test it with plain `curl`:

```sh
# initialize
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# list the tools
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# search, then fetch the top hit
curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"OSC 133"}}}'

curl -s -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get","arguments":{"id":"terminal-osc/133"}}}'
```

By default the shim fetches from `https://wire.phall.io`. To point it at a local
build of the site instead, set `WIRE_ORIGIN` (e.g. to a running
`astro preview`) in `wrangler.jsonc` `vars`, or pass `--var WIRE_ORIGIN:http://localhost:4321`.

## Type-check

```sh
bunx tsc --noEmit
```

## Deploy

```sh
bunx wrangler deploy
```

This publishes the Worker as `wire-mcp`. The first deploy prints the public URL
(`https://wire-mcp.<your-subdomain>.workers.dev`); the MCP endpoint is that URL
plus `/mcp`. You can also bind a custom route (e.g. `mcp.wire.phall.io`) in the
Cloudflare dashboard or via a `routes` entry in `wrangler.jsonc`.

## Add it to an MCP client

The server speaks the **Streamable HTTP** transport (MCP spec `2025-06-18`) at
`https://<your-worker-url>/mcp`.

### Claude (Desktop / Code) — remote server

Most Claude clients connect to remote HTTP MCP servers directly. In
**Settings → Connectors / MCP servers → Add**, give it the URL:

```
https://wire-mcp.<your-subdomain>.workers.dev/mcp
```

### Clients that only speak stdio (config-file style)

For a client that launches local stdio servers, bridge to the remote HTTP
endpoint with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```jsonc
{
  "mcpServers": {
    "wire": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://wire-mcp.<your-subdomain>.workers.dev/mcp"]
    }
  }
}
```

(For Claude Desktop this file is `claude_desktop_config.json`; restart the app
after editing.)

### Claude Code (CLI)

```sh
claude mcp add --transport http wire https://wire-mcp.<your-subdomain>.workers.dev/mcp
```

Once connected, the model can call `search`, `get`, `list_families`, and
`get_family` natively.

## Files

| File | Role |
|---|---|
| `src/index.ts` | Worker entry: routes `/mcp` (POST JSON-RPC), CORS, landing page. |
| `src/mcp.ts` | Minimal MCP server: JSON-RPC dispatch, tool registry, `initialize`/`tools/list`/`tools/call`. |
| `src/wire-client.ts` | The stateless shim: typed `fetch` wrappers over wire's live JSON + the search ranker. |
| `wrangler.jsonc` | Worker config (`name: wire-mcp`, `compatibility_date: 2026-05-01`). |
