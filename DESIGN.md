# wire.phall.io — Design

> One place to look up a computer/network/API/terminal protocol or standard —
> served for both humans (rendered page) and agents (curlable JSON), searchable,
> correctness-first, and largely self-maintaining.

This document is the canonical design. It was produced by a fan-out research +
judge-panel workflow (4 research agents → 3 independent design proposals → a
synthesis judge → a worked seed + architecture). Sources for every external
claim are recorded inline in the entries themselves (`source_url`, `attribution[]`).

---

## 1. The problem

Protocols are everywhere but the references are not. Standards bodies write for
implementers (dense, scattered, paywalled); the de-facto stuff (terminal escape
sequences, vendor extensions) lives in tribal knowledge, source code, and one
person's gist. There is no MDN-for-protocols. And LLMs hallucinate these
constantly — ask for the exact OSC 133 sequence and most models get the
terminator wrong — precisely because their training data is mush.

The wedge: an accurate, structured, **curlable** reference that an agent can hit
at *one* stable URL and trust without a second call, starting with the
worst-documented surface we use daily (terminal escape sequences).

This is a **content product**, not an infra product. The moat is that the bytes
are right. Hosting is nearly free (static files on a CDN + a thin edge shim).

**Design principle — small and snappy.** It's just the place you go to *get the
stuff*: a minimal, fast, static human page and the same fact as clean JSON for
agents. No app, no runtime harness, no accounts. Every feature is weighed
against "does this keep the site tiny and instant." The only moving parts are
the build (data → static files) and the offline update agent (keeps the data
current). What we ship to the edge is just files.

---

## 2. Source-of-truth tiers (verified)

The tier decides whether an LLM is in the ingestion loop at all. Putting an agent
where a parser would do just adds hallucination risk to already-clean data.

| Tier | Sources | Ingestion | LLM? |
|---|---|---|---|
| **A** | IANA registries (HTTP status/methods/headers, media types, URI schemes, ports, DNS, TLS, CBOR tags) — machine-readable CSV/XML at stable URLs, RFC4180 / schema-backed, `Last-Modified` for cheap conditional polling | Deterministic parser + config map `{registry → url, format}`. Self-healing via round-trip diff. | **No** |
| **B** | Structured-but-curated specs: xterm `ctlseqs` (Thomas Dickey, invisible-island.net — the de-facto CSI/OSC registry), ECMA-48 | Targeted extractor + thin LLM normalization for edge-case prose + human gate | Light |
| **C** | De-facto / proprietary / multi-source: OSC 133 (FinalTerm origin; Per Bothner's *Semantic Prompts* proposal; iTerm2/Contour/MS docs), OSC 633 (VS Code) | LLM synthesis across sources + **cross-source quorum** + human gate | Yes |
| **enc** | Encodings (base64, percent-encoding, punycode) | Deterministic **test-vector execution** in CI | No |

Key facts pinned by research:
- **No registry exists for OSC command numbers.** ECMA-48 defines only the
  `ESC ]` … `ST` *frame*; the numbers are allocated ad hoc by whoever ships
  first. So we may safely mint `terminal-osc/{n}` as our own canonical ids.
- **Terminator divergence:** ECMA-48 mandates `ST` (`ESC \`); xterm and ~all
  modern terminals also accept `BEL` (`0x07`). Rule: **emit ST, accept both.**

---

## 3. Licensing stance (verified, US-centric)

Two-layer content model, safe by construction:

- **Fact layer** — byte sequences, code numbers, wire layouts, opcodes, status
  codes, parameter tables, bare grammar. *Uncopyrightable facts / methods of
  operation* (17 USC 102(b), Feist, merger doctrine). Reproduce freely from any
  source **with citation** — including ISO and GPL vendor docs.
- **Prose layer** — explanations, narrative, examples, diagrams. *Copyrightable.*
  Write in our own words; do not bulk-copy source prose.

Per source: **IETF RFCs** quotable verbatim (keep excerpts < 20% per RFC, else
include the IETF legend). **ECMA** verbatim only with its notice block — easier
to restate. **ISO** never reproduce — restate facts, cite the number, prefer the
free ECMA equivalent (ECMA-48 == ISO/IEC 6429, ECMA-404 == ISO 21778). **W3C**
quotable with link+notice; check if the spec actually lives at **WHATWG**
(CC-BY 4.0). **Vendor docs** (iTerm2 GPLv2, kitty GPLv3) — restate facts, cite,
don't copy prose. A per-source attribution template makes this compliant
automatically.

---

## 4. Data model

### Permalink scheme — conditional-depth path

```
https://wire.phall.io/{family}/{slug}                     (default, 2-segment)
https://wire.phall.io/{family}/{namespace}/{slug}         (only for colliding key-spaces)
```

- `{family}` is a **closed, curated vocabulary**, deliberately decoupled from
  IANA's irregular download filenames (`http-status-codes-1.csv`, `methods.csv`).
- `{slug}` is the family-local natural key (number, canonical token, or
  kebab-cased media type — `application/json` → `application-json`).
- **Sub-facts are `#fragments`, never path segments** — `…/133#D`,
  `…/sgr#38-5`, `…/133#fact-d-exitcode`. People cite *OSC 133*, not *OSC-133-C*,
  and an agent fetching the parent already holds every sub-fact (no N+1).
- JSON is canonical; HTML is the derived alternate. An explicit
  `.json`/`.txt`/`.md` suffix overrides content negotiation for `curl`.
- A **301 redirect table** absorbs under-specified guesses:
  `/418 → /http-status/418`, `/osc/133 → /terminal-osc/133`.

Examples: `terminal-osc/133`, `terminal-csi/sgr#38-5`,
`terminal-dec-private-mode/2004`, `http-status/418`, `http-method/PATCH`,
`media-type/application-json`, `uri-scheme/mailto`, `port/443#tcp`,
`tls-param/cipher-suites/0x1301` (3-segment), `dns-rrtype/AAAA`, `cbor-tag/0`.

### Core schema (frozen ~18 fields)

Every entry, every family, carries the same core so an agent parses any response
with one schema. Provenance is **mandatory and inline**. Full schema:
[`schema/core.schema.json`](schema/core.schema.json). The load-bearing fields:

- Identity: `id`, `family`, `namespace?`, `slug`, `title`, `summary`, `kind`, `aliases?`
- Trust: `status` (standardization of the *thing*), `verification`
  (`verified|unverified|contested` — trust of *this entry's data*), `tier` (A/B/C)
- Provenance: `source_url`, `source_version`, `retrieved_date`,
  `attribution[]` (per-fact citations, **mandatory for tier C / multi-source**)
- Graph + extension: `see_also[]`, `ext_type`, `ext`, `updated`

### Extension strategy

All category-specific data lives in a single `ext` object whose shape is named by
a **versioned** `ext_type` (`terminal-escape@1`, `iana-registry-row@1`,
`encoding@1`). New families add a new `ext_type` without touching the core or any
existing entry — the corpus extends with zero migration. Sub-schemas live under
[`schema/ext/`](schema/ext/).

### Granularity rule

One entry = one citable, addressable unit you'd naturally name and link to.
Decision test, in order: (1) does an authoritative registry assign it its own
row/number? → one entry per row. (2) else, is it the smallest thing a
practitioner names on its own? → that's the entry; finer structure becomes
`#fragment`-addressable items in `ext`. (3) never split so fine a common query
needs N fetches; never lump two independently-versioned standards into one id.

---

## 5. Verification — data integrity only

"Verification" here means **the data we serve is well-formed, cited, and
internally correct** — not that we drive real implementations. The site is a
reference, not a conformance harness. Five deterministic CI gates, all emitting
machine-readable diffs, failing the build on violation:

1. **Schema** — validates against core + declared versioned `ext_type`.
2. **Provenance lint** — provenance fields present everywhere; tier C /
   multi-source entries carry `attribution[]` covering each load-bearing claim.
3. **Tier-A round-trip** — re-fetch IANA upstream, re-parse, diff against stored
   `ext.iana-registry-row`; drift auto-updates or flags a conflict (self-healing).
4. **Encoding test-vector execution** — actually run `input → output` in CI and
   assert equality. Codec facts are *proven*, not asserted.
5. **Cross-source quorum** — tier C requires ≥2 independent agreeing
   `source_url`s; disagreement sets `verification = contested`, not silent resolution.

**The single most important lever, and it's free:** any entry failing the gates
ships as `verification: unverified` and is **excluded from the default search
index**. Reachable by direct id, invisible to search. Trust beats breadth.

### Non-goals (explicitly out of scope)

- **Not a conformance harness.** We do not drive real terminal emulators / HTTP
  servers / codecs and assert their behavior. The established tools already do
  that (`esctest`/`vttest` for terminals, `h2spec`, WPT, etc.) — we link to them
  where useful, we don't reimplement them.
- The `support_matrix` is **curated, cited data** ("docs say terminal X supports
  this since version Y"), not behavioral test results. Each cell carries its
  source like any other fact; if sources disagree the entry goes `contested`.
- The v1 seed's [`osc133.smoke.test.mjs`](test/osc133.smoke.test.mjs) is a
  **data-integrity** check (do the stored byte sequences parse, are both
  terminator forms recorded), not a behavioral test of any terminal.

This keeps the thing **small**: a static corpus + integrity gates, no runtime
harness to maintain.

---

## 6. Architecture

- **Hosting:** static-first on Cloudflare. *(Open decision: Pages Functions vs
  Workers Static Assets — see §8.)* Build output in `dist/` is the immutable,
  deterministic artifact: per-entry `.json`, pre-rendered HTML, `index.json`
  manifests, `_pagefind/` search index, `/llms.txt`, `/llms-full.txt`.
- **Dual serving** at the edge shim, resolution order: (1) redirect table →
  301; (2) explicit suffix overrides negotiation → forced Content-Type; (3)
  `Accept` negotiation on the bare path → same `.json` bytes or pre-rendered
  HTML. `Vary: Accept`, `ETag` from `entry.updated`, `Cache-Control` on every
  response so the CDN caches variants separately.
- **Search:** Pagefind — Rust/WASM, prebuilt sharded index, fully client-side,
  no backend, ~100–300 kB even at scale. Indexes only `verification != unverified`.
  Agents don't use search; they enumerate manifests and fetch by constructed id.
- **Agent interface:** `/llms.txt` (token-lean index: purpose, family vocabulary,
  manifest links) + `/llms-full.txt` (inlined dump) + per-family `index.json`.
  Later: a **stateless MCP server** that is a thin shim over the *identical*
  static JSON, so the curl interface and the agent interface can never diverge.

### Update agent

Invocation surfaces, all sharing one core that **emits a reviewable diff, never a
silent write**:
- **CLI:** `protocols ingest [--family X] [--dry-run] [--open-pr]`
- **Claude skill / MCP tool:** proposes an entry/field change, returns diff +
  provenance for human approval (the LLM does Tier-C extraction here)
- **Scheduled CI:** nightly Tier-A IANA poll (conditional GET); on drift, opens a
  PR with the diff + bumped dates. Self-healing for Tier A, human-gated for
  anything that changes semantics.

Contract: input = target + upstream source(s) + current `data/`; output = a patch
to `data/…` plus a machine-readable change report (per-field old→new, each new
claim carrying provenance, gate results). The agent cannot merge, cannot mutate
served content, cannot bypass the gates. Unverifiable entries ship as
`unverified`, never dropped or guessed.

### Repo layout (target)

```
data/{family}/[{namespace}/]{slug}.json   source of truth, one file per entry
schema/core.schema.json                   frozen core
schema/ext/*.v1.schema.json               versioned extension sub-schemas
ingest/registries.config.json             Tier-A config map {registry → url,format}
ingest/{tier-a,tier-b,tier-c}/            adapters per tier (LLM only where needed)
ingest/diff.ts                            reviewable-patch + change-report; opens PR
build/build.ts                            pure: validate → JSON → manifests → HTML → pagefind → llms.txt
ci/gates/                                 the 5 gates
test/                                     conformance tests (e.g. osc133.smoke.test.mjs)
mcp/server.ts                             stateless MCP shim over dist JSON
dist/                                     immutable deploy artifact
.github/workflows/{ingest,deploy}.yml     nightly Tier-A PRs; gates+build+deploy
```

---

## 7. What exists now (this commit)

- [`data/terminal-osc/133.json`](data/terminal-osc/133.json) — the **byte-accurate
  OSC 133 seed entry** and the exemplar every future entry is modeled on. Full
  A/B/C/D markers (ST + BEL forms), optional `D;exitcode`, 11-terminal support
  matrix, OSC 633 variant cross-link, gotchas, and `attribution[]` with two
  independent agreeing sources per A/B/C/D claim (quorum satisfied → `verified`).
- [`schema/core.schema.json`](schema/core.schema.json) and
  [`schema/ext/terminal-escape.v1.schema.json`](schema/ext/terminal-escape.v1.schema.json).
- [`test/osc133.smoke.test.mjs`](test/osc133.smoke.test.mjs) — v1 **data-integrity**
  check. **Passing (12/12):** validates every stored byte sequence against a
  strict OSC-133 grammar, confirms both terminator forms are recorded, confirms
  `D`'s exit-code variant, and asserts a byte-exact full
  prompt→command→output→finish cycle. (`node --test test/osc133.smoke.test.mjs`)

---

## 8. Open decisions

1. **Hosting: Cloudflare Workers Static Assets vs Pages Functions.** Research
   recommends **Workers Static Assets** (Cloudflare is folding Pages into Workers;
   Workers is the only path that lets the future MCP endpoint live in the *same*
   deploy via `run_worker_first` on `/mcp`). The architecture pass defaulted to
   Pages Functions (more turnkey Git CI/CD). **Decide before wiring hosting.**
2. **Data file format:** JSON (unambiguous control-byte escaping via ``,
   used for the seed) vs YAML (nicer to hand-author). Leaning JSON for the
   byte-bearing terminal families, YAML acceptable for prose-light IANA rows.
3. **Build tooling / SSG:** hand-rolled TS build vs an SSG (Astro/Eleventy).
   Affects how Pagefind, the `.json`/`.md` twins, and `llms.txt` hook in.
4. **First non-terminal coverage after the wedge:** likely Tier-A IANA (free,
   deterministic) — `http-status`, then the TLV family / encodings.

## 9. Top risks (from the synthesis)

- Family vocabulary is a human curation chokepoint; a wrong call is a
  permalink-stability liability. Mitigate with a documented assignment rubric +
  the 301 redirect table.
- v1 terminal entries prove *documents agree*, not that emulators *behave*
  (Ghostty historical subset, VS Code emits 633 not pure 133, BEL-vs-ST). v2
  behavioral gate closes this.
- Tier-C `attribution[]` is labor-intensive and can go stale (semantic-prompts.md
  is served as a JS shell, hard to auto-diff) — risk of stale "verified" citations.
- Conditional-depth permalinks weaken the "just construct the URL" promise; the
  per-family depth is published in `llms.txt` and resolved via search + 301s.
- Tier-A ingestion breaks if an upstream IANA filename moves (it's a per-registry
  constant, not derivable) — needs a fetch-failure alarm, not just drift-diff.
