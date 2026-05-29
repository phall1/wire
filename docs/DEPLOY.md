# Deploy — wire.phall.io

Hosting is **Cloudflare Workers Static Assets** (not Pages). The Worker
(`src/worker.js`) sits in front of the static `dist/` artifact so it can do 301
redirects and `Accept` content-negotiation; everything it doesn't own falls
through to the static asset server via the `ASSETS` binding. This is the path
that lets the future MCP endpoint share the same deploy (a `run_worker_first`
route on `/mcp`).

Config lives in [`wrangler.jsonc`](../wrangler.jsonc).

---

## Prerequisites

- Node 20+ and `npx` (Wrangler is invoked via `npx`, no global install needed).
- A Cloudflare account with the `phall.io` zone already onboarded.
- One-time auth: `npx wrangler login` (opens a browser; stores an OAuth token).
  CI uses a `CLOUDFLARE_API_TOKEN` env var instead.

---

## Build

The build is pure: `data/` + `schema/` -> validated `dist/`. It must produce,
into `dist/`, the layout the Worker expects:

```
dist/
  redirects.json                     the 301 table { "/418": "/http-status/418", ... }
  terminal-osc/133.json              canonical fact bytes (one per entry)
  terminal-osc/133.html              pre-rendered human page (one per entry)
  index.json                         family/entry manifests
  llms.txt  llms-full.txt            agent index
  _pagefind/                         client-side search index
  assets/                            css/js/images
```

Build it:

```sh
npm install
npm run build
```

Sanity-check the artifact before deploying:

```sh
ls dist/redirects.json dist/terminal-osc/133.json dist/terminal-osc/133.html
```

---

## Deploy

```sh
npx wrangler deploy
```

This uploads `dist/` as static assets and publishes `src/worker.js`. On first
deploy it prints the `*.workers.dev` URL — use it to smoke-test before the
custom domain is attached.

To preview locally without deploying:

```sh
npx wrangler dev
```

`wrangler dev` serves the real `dist/` through the real Worker, so the
negotiation/redirect logic is exercised exactly as in production.

---

## Custom domain: wire.phall.io

`wire.phall.io` is a subdomain of the existing `phall.io` Cloudflare zone.
Attach it as a **Custom Domain** on the Worker (this provisions the CNAME and
TLS automatically — do not hand-create a DNS record that points elsewhere).

**Option A — dashboard (recommended):**

1. Cloudflare dashboard -> Workers & Pages -> `protocols` -> **Settings** ->
   **Domains & Routes** -> **Add** -> **Custom Domain**.
2. Enter `wire.phall.io`.
3. Cloudflare creates a proxied `CNAME protocols -> protocols.<account>.workers.dev`
   in the `phall.io` zone and issues an edge TLS certificate automatically.
   No manual DNS edit and no separate cert step.

**Option B — declarative in `wrangler.jsonc`:** add a `routes` entry with
`custom_domain: true`, then `npx wrangler deploy`:

```jsonc
"routes": [
  { "pattern": "wire.phall.io", "custom_domain": true }
]
```

Wrangler provisions the same CNAME + TLS on deploy. Both options are
equivalent; the dashboard is easier for a one-off, the config is better for
reproducibility.

Propagation + cert issuance is usually under a minute since the zone is already
on Cloudflare.

---

## Test dual-serving with curl

Run these against the live domain (or swap in the `*.workers.dev` URL while the
custom domain is provisioning). Use single quotes around the whole command.

**Bare path, agent (JSON):**

```sh
curl -s -H 'Accept: application/json' 'https://wire.phall.io/terminal-osc/133' | head
```

Expect the canonical JSON bytes (`"id": "terminal-osc/133"`), with response
headers `Content-Type: application/json`, `Vary: Accept`, an `ETag`, and
`Access-Control-Allow-Origin: *`.

**Bare path, human (HTML) — same URL, different Accept:**

```sh
curl -s 'https://wire.phall.io/terminal-osc/133' | head
```

Expect `text/html` (the pre-rendered page).

**Explicit suffix overrides negotiation (forced Content-Type):**

```sh
curl -sI 'https://wire.phall.io/terminal-osc/133.json'
curl -sI 'https://wire.phall.io/terminal-osc/133.txt'
```

`.json` forces `application/json` and `.txt` forces `text/plain` regardless of
the `Accept` header.

**301 redirect for an under-specified guess:**

```sh
curl -sI 'https://wire.phall.io/osc/133'
```

Expect `HTTP/2 301` with `Location: /terminal-osc/133` (assuming that mapping
is in `dist/redirects.json`).

**CORS preflight (agents fetching cross-origin):**

```sh
curl -si -X OPTIONS 'https://wire.phall.io/terminal-osc/133' \
  -H 'Origin: https://example.com' \
  -H 'Access-Control-Request-Method: GET'
```

Expect `204` with `Access-Control-Allow-Origin: *`.

**Headers in full (inspect Vary / ETag / Cache-Control / CORS):**

```sh
curl -sD - -o /dev/null -H 'Accept: application/json' \
  'https://wire.phall.io/terminal-osc/133'
```

**Conditional GET (304 on matching ETag):**

```sh
ETAG=$(curl -sD - -o /dev/null -H 'Accept: application/json' \
  'https://wire.phall.io/terminal-osc/133' | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
curl -sI -H 'Accept: application/json' -H "If-None-Match: $ETAG" \
  'https://wire.phall.io/terminal-osc/133'
```

Expect `HTTP/2 304`.

---

## Rollback

```sh
npx wrangler deployments list
npx wrangler rollback [<deployment-id>]
```

Static assets are versioned with the Worker, so a rollback reverts both the
code and the served `dist/` together.
