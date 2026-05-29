# wire.phall.io

> the exact bytes that cross the wire — codes, sequences, and registry values,
> for humans and agents.

A single, searchable, **curlable** reference for computer / network / API /
terminal protocols and standards — served for both humans (a fast, terminal-styled
static page) and AI agents (the same fact as structured JSON at a stable URL),
correctness-first, with inline provenance, and designed to be largely
self-maintained by agents.

Read **[DESIGN.md](DESIGN.md)** for the full design (source-of-truth tiers,
licensing stance, permalink scheme, core schema, the five integrity gates) and
**[docs/DEPLOY.md](docs/DEPLOY.md)** to ship it.

## Stack

- **Astro 6** + **Tailwind v4** + **TypeScript** (strict), built and run with **Bun**
- Static output → **Cloudflare Pages** (`bunx wrangler pages deploy ./dist`)
- Corpus: one JSON file per entry under `data/`, loaded as an Astro content
  collection; pages + `.json` twins + `llms.txt` are all generated at build time
- Data-integrity gates and tests run on Bun (`bun run gates`, `bun test`)

## Develop

```sh
bun install
bun run dev        # astro dev
bun run build      # prebuild (redirects) + astro build → dist/
bun run gates      # 5 data-integrity gates over the corpus
bun test           # integrity tests
bun run ingest -- --family http-status --dry-run   # Tier-A update agent
```

## Corpus

1,302 entries across 11 families (HTTP status/methods, URI schemes, ports, DNS
record types, CBOR tags, TLS cipher suites, terminal OSC/CSI/DEC sequences,
encodings). Tier-A families are regenerated deterministically from the IANA
registries by `ingest/`; terminal entries are sourced from xterm ctlseqs / the
Semantic Prompts proposal with inline `attribution[]`.

## The idea in one line

The reference an agent can hit at *one* place to get a protocol fact right —
because the bytes are verified and the provenance is inline.
