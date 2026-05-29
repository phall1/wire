# wire.phall.io

A single, searchable, **curlable** reference for computer / network / API /
terminal protocols and standards — served for both humans (rendered pages) and
AI agents (structured JSON at a stable URL), correctness-first, and designed to
be largely self-maintained by agents.

Read **[DESIGN.md](DESIGN.md)** for the full design: source-of-truth tiers,
licensing stance, the permalink scheme and core schema, the five verification
gates, and the Cloudflare architecture.

## Status: bootstrapping

The design is complete and the first byte-accurate seed entry is in:

- `data/terminal-osc/133.json` — the OSC 133 (semantic shell-prompt) exemplar.
- `schema/` — frozen core schema + the `terminal-escape@1` extension schema.
- `test/osc133.smoke.test.mjs` — conformance smoke test (passing).

```sh
node --test test/osc133.smoke.test.mjs
```

## The idea in one line

The reference an agent can hit at *one* place to get a protocol fact right —
because the bytes are verified and the provenance is inline.
