#!/usr/bin/env node
// wire.phall.io static-site build pipeline.
// Reads every data/**/*.json entry and emits a fully static dist/.
// Zero runtime deps; Node built-ins only at runtime. ajv is a build-time gate.
//
// Permalink/id == '{family}[/{namespace}]/{slug}'. JSON is canonical; HTML is
// the derived alternate. The build is generic over families and ext_types so
// it scales from one entry to ~500 with no changes.

import { readFile, readdir, mkdir, writeFile, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SCHEMA_DIR = path.join(ROOT, "schema");
const ASSETS_SRC = path.join(__dirname, "assets");
const DIST = path.join(ROOT, "dist");

// Hardcoded per the build contract: never compute today's date at runtime.
const TODAY = "2026-05-29";

// The closed family vocabulary, mirrored from core.schema.json's enum, with a
// short human label for each. Kept here so the home/family pages can describe
// the vocabulary without re-parsing the schema at request time.
const FAMILY_VOCAB = {
  "terminal-osc": "Terminal OSC (Operating System Command) sequences",
  "terminal-csi": "Terminal CSI (Control Sequence Introducer) sequences",
  "terminal-dec-private-mode": "DEC private mode set/reset toggles",
  "http-status": "HTTP status codes",
  "http-method": "HTTP request methods",
  "media-type": "Media types (MIME types)",
  "uri-scheme": "URI schemes",
  "port": "Service port numbers",
  "tls-param": "TLS parameters (cipher suites, extensions, ...)",
  "dns-rrtype": "DNS resource record types",
  "cbor-tag": "CBOR tags",
  "encoding": "Encodings (base64, percent-encoding, punycode, ...)",
};

const SITE_NAME = "wire.phall.io";
const SITE_PURPOSE =
  "One place to look up a computer / network / API / terminal protocol or standard — served for both humans (rendered page) and agents (curlable JSON), correctness-first, with inline provenance.";

// ---------------------------------------------------------------------------
// HTML escaping helpers
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Byte sequences are stored with JSON  escapes (i.e. real control bytes
// in the parsed string). For display we render them as printable \xNN forms so
// the page never emits a raw control byte into HTML.
function visibleBytes(s) {
  if (s == null) return "";
  let out = "";
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += "\\x" + code.toString(16).padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

function codeBytes(s) {
  if (s == null || s === "") return "";
  return `<code class="bytes">${esc(visibleBytes(s))}</code>`;
}

// ---------------------------------------------------------------------------
// Data loading: data/ then any subdir then .json
// ---------------------------------------------------------------------------

async function loadEntries() {
  const files = [];
  async function walk(dir) {
    const dirents = await readdir(dir, { withFileTypes: true });
    // Deterministic order for reproducible builds.
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full);
      else if (d.isFile() && d.name.endsWith(".json")) files.push(full);
    }
  }
  if (!existsSync(DATA_DIR)) throw new Error(`No data dir at ${DATA_DIR}`);
  await walk(DATA_DIR);

  const entries = [];
  for (const f of files) {
    const raw = await readFile(f, "utf8");
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Invalid JSON in ${f}: ${e.message}`);
    }
    entries.push({ file: f, entry: obj });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Schema gate (ajv). Soft-fails gracefully if ajv is not installed so the
// build can still run, but logs loudly. The CI gates enforce hard.
// ---------------------------------------------------------------------------

async function buildValidator() {
  let Ajv, addFormats;
  try {
    Ajv = (await import("ajv/dist/2020.js")).default;
    addFormats = (await import("ajv-formats")).default;
  } catch {
    return null; // ajv not installed; skip validation in this build run.
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const core = JSON.parse(await readFile(path.join(SCHEMA_DIR, "core.schema.json"), "utf8"));
  ajv.addSchema(core, "core");

  // Map ext_type -> compiled ext schema. New ext_types: drop a file under
  // schema/ext/ and register it here by its declared ext_type.
  const extSchemas = {};
  const extDir = path.join(SCHEMA_DIR, "ext");
  if (existsSync(extDir)) {
    for (const name of await readdir(extDir)) {
      if (!name.endsWith(".json")) continue;
      const sch = JSON.parse(await readFile(path.join(extDir, name), "utf8"));
      // Derive ext_type from the file: terminal-escape.v1 -> terminal-escape@1
      const m = name.match(/^(.+)\.v(\d+)\.schema\.json$/);
      if (m) extSchemas[`${m[1]}@${m[2]}`] = ajv.compile(sch);
    }
  }
  const validateCore = ajv.compile(core);
  return { validateCore, extSchemas };
}

// ---------------------------------------------------------------------------
// Manifest projections
// ---------------------------------------------------------------------------

function manifestRow(e) {
  return {
    id: e.id,
    title: e.title,
    status: e.status,
    verification: e.verification,
    kind: e.kind,
  };
}

function searchRow(e) {
  return {
    id: e.id,
    title: e.title,
    summary: e.summary,
    aliases: e.aliases || [],
    family: e.family,
    kind: e.kind,
  };
}

// ---------------------------------------------------------------------------
// Shared HTML chrome
// ---------------------------------------------------------------------------

function badge(kind, value) {
  return `<span class="badge badge-${esc(kind)} badge-${esc(kind)}-${esc(String(value).replace(/[^a-z0-9]+/gi, "-").toLowerCase())}">${esc(value)}</span>`;
}

function page({ title, description, jsonAlternate, body, bodyClass }) {
  const altLink = jsonAlternate
    ? `\n    <link rel="alternate" type="application/json" href="${esc(jsonAlternate)}">`
    : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">${altLink}
    <link rel="stylesheet" href="/assets/style.css">
  </head>
  <body${bodyClass ? ` class="${esc(bodyClass)}"` : ""}>
    <header class="site-header">
      <a class="brand" href="/">${esc(SITE_NAME)}</a>
      <nav><a href="/">home</a> <a href="/llms.txt">llms.txt</a></nav>
    </header>
    <main>
${body}
    </main>
    <footer class="site-footer">
      <p>Correctness-first protocol reference. Every fact carries inline provenance. Add <code>.json</code> to any path, or send <code>Accept: application/json</code>, for the raw entry.</p>
    </footer>
  </body>
</html>
`;
}

// ---------------------------------------------------------------------------
// ext renderers, dispatched by ext_type
// ---------------------------------------------------------------------------

function renderTable(headers, rows) {
  if (!rows.length) return "";
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function renderTerminalEscape(ext) {
  const parts = [];

  // Frame
  if (ext.frame) {
    const f = ext.frame;
    const frameRows = [];
    if (f.introducer_7bit) frameRows.push(["Introducer (7-bit)", codeBytes(f.introducer_7bit), esc(f.introducer_7bit_readable || "")]);
    if (f.introducer_8bit) frameRows.push(["Introducer (8-bit)", codeBytes(f.introducer_8bit), esc(f.introducer_8bit_readable || "")]);
    parts.push(`<section><h2>Frame</h2>`);
    parts.push(`<p>${esc(ext.csi_or_osc)}${ext.command_number != null ? ` <strong>${esc(String(ext.command_number))}</strong>` : ""}</p>`);
    if (frameRows.length) parts.push(renderTable(["", "Bytes", "Readable"], frameRows));
    if (f.note) parts.push(`<p class="note">${esc(f.note)}</p>`);
    parts.push(`</section>`);
  }

  // Params table (sub-facts addressed by #anchor)
  if (Array.isArray(ext.params) && ext.params.length) {
    const rows = ext.params.map((p) => {
      const anchor = (p.anchor || `#${p.id}`).replace(/^#/, "");
      let cell = `<a id="${esc(anchor)}" href="#${esc(anchor)}"><code>${esc(p.id)}</code></a>`;
      // Append subparam example bytes inline if present.
      let extra = "";
      if (Array.isArray(p.subparams) && p.subparams.length) {
        const subs = p.subparams
          .map((sp) => {
            const sa = (sp.anchor || `#${sp.id}`).replace(/^#/, "");
            const ex = sp.example_byte_sequence_ST ? ` ${codeBytes(sp.example_byte_sequence_ST)}` : "";
            return `<div class="subparam"><a id="${esc(sa)}" href="#${esc(sa)}"><code>${esc(sp.id)}</code></a> ${esc(sp.name || "")} — ${esc(sp.meaning || "")}${ex}</div>`;
          })
          .join("");
        extra = `<div class="subparams">${subs}</div>`;
      }
      return [
        cell,
        esc(p.name || ""),
        esc(p.meaning || "") + extra,
        codeBytes(p.byte_sequence_ST),
        codeBytes(p.byte_sequence_BEL),
      ];
    });
    parts.push(`<section><h2>Parameters</h2>`);
    parts.push(renderTable(["Id", "Name", "Meaning", "Bytes (ST)", "Bytes (BEL)"], rows));
    parts.push(`</section>`);
  }

  // Terminator detail
  parts.push(`<section><h2>Terminator</h2>`);
  parts.push(`<p>Accepted: <code>${esc(ext.terminator)}</code></p>`);
  if (ext.terminator_detail) {
    const t = ext.terminator_detail;
    const tRows = [];
    if (t.canonical_ST_7bit) tRows.push(["ST (7-bit, canonical)", codeBytes(t.canonical_ST_7bit), esc(t.canonical_ST_7bit_readable || "")]);
    if (t.canonical_ST_8bit) tRows.push(["ST (8-bit)", codeBytes(t.canonical_ST_8bit), esc(t.canonical_ST_8bit_readable || "")]);
    if (t.alt_BEL) tRows.push(["BEL (alternate)", codeBytes(t.alt_BEL), esc(t.alt_BEL_readable || "")]);
    if (tRows.length) parts.push(renderTable(["", "Bytes", "Readable"], tRows));
    if (t.note) parts.push(`<p class="note">${esc(t.note)}</p>`);
  }
  parts.push(`</section>`);

  // Support matrix
  if (Array.isArray(ext.support_matrix) && ext.support_matrix.length) {
    const rows = ext.support_matrix.map((m) => [
      esc(m.terminal),
      badge("level", m.level),
      esc(m.version_added || ""),
      esc(m.notes || ""),
    ]);
    parts.push(`<section><h2>Support matrix</h2>`);
    parts.push(`<p class="note">Curated, cited documentation claims — not behavioral test results.</p>`);
    parts.push(renderTable(["Terminal", "Level", "Since", "Notes"], rows));
    parts.push(`</section>`);
  }

  // Variants
  if (Array.isArray(ext.variants) && ext.variants.length) {
    const items = ext.variants
      .map((v) => {
        const link = v.entry_id ? `<a href="/${esc(v.entry_id)}">${esc(v.label || v.entry_id)}</a>` : esc(v.label || "");
        return `<li>${link}${v.note ? ` — ${esc(v.note)}` : ""}</li>`;
      })
      .join("\n");
    parts.push(`<section><h2>Variants</h2>\n<ul>${items}</ul>\n</section>`);
  }

  // Gotchas
  if (Array.isArray(ext.gotchas) && ext.gotchas.length) {
    const items = ext.gotchas.map((g) => `<li>${esc(g)}</li>`).join("\n");
    parts.push(`<section><h2>Gotchas</h2>\n<ul class="gotchas">${items}</ul>\n</section>`);
  }

  return parts.join("\n");
}

function rfcLink(ref) {
  // Accept "RFC 7231", "RFC7231", "7231" -> link to rfc-editor.org.
  const m = String(ref).match(/(\d{3,5})/);
  if (m) return `<a href="https://www.rfc-editor.org/rfc/rfc${m[1]}.html">${esc(ref)}</a>`;
  return esc(ref);
}

function renderIanaRow(ext) {
  const parts = [];
  parts.push(`<section><h2>Registry row</h2>`);
  const kv = [];
  if (ext.value != null) kv.push(["Value", `<code>${esc(String(ext.value))}</code>`]);
  if (ext.registrant) kv.push(["Registrant", esc(ext.registrant)]);
  if (ext.date) kv.push(["Date", esc(ext.date)]);
  if (Array.isArray(ext.reference) && ext.reference.length) {
    kv.push(["Reference", ext.reference.map(rfcLink).join(", ")]);
  } else if (ext.reference) {
    kv.push(["Reference", rfcLink(ext.reference)]);
  }
  if (kv.length) parts.push(renderTable(["", ""], kv));
  parts.push(`</section>`);

  if (ext.raw_columns && typeof ext.raw_columns === "object") {
    const rows = Object.entries(ext.raw_columns).map(([k, v]) => [esc(k), `<code>${esc(String(v))}</code>`]);
    parts.push(`<section><h2>Raw columns</h2>\n${renderTable(["Column", "Value"], rows)}\n</section>`);
  }
  return parts.join("\n");
}

function renderEncoding(ext) {
  const parts = [];
  const meta = [];
  if (ext.alphabet) meta.push(["Alphabet", `<code>${esc(ext.alphabet)}</code>`]);
  if (ext.rfc) meta.push(["RFC", rfcLink(ext.rfc)]);
  if (meta.length) parts.push(`<section><h2>Definition</h2>\n${renderTable(["", ""], meta)}\n</section>`);

  if (Array.isArray(ext.test_vectors) && ext.test_vectors.length) {
    const rows = ext.test_vectors.map((v) => [
      `<code>${esc(String(v.input))}</code>`,
      esc(v.input_form || ""),
      `<code>${esc(String(v.output))}</code>`,
      esc(v.output_form || ""),
      esc(v.note || ""),
    ]);
    parts.push(`<section><h2>Test vectors</h2>\n${renderTable(["Input", "Input form", "Output", "Output form", "Note"], rows)}\n</section>`);
  }
  return parts.join("\n");
}

function renderExt(entry) {
  const ext = entry.ext || {};
  switch (entry.ext_type) {
    case "terminal-escape@1":
      return renderTerminalEscape(ext);
    case "iana-registry-row@1":
      return renderIanaRow(ext);
    case "encoding@1":
      return renderEncoding(ext);
    default:
      return `<section><h2>Extension data (${esc(entry.ext_type)})</h2>\n<pre class="json">${esc(JSON.stringify(ext, null, 2))}</pre>\n</section>`;
  }
}

// ---------------------------------------------------------------------------
// Entry page
// ---------------------------------------------------------------------------

function renderEntryPage(entry) {
  const badges = [
    badge("status", entry.status),
    badge("verification", entry.verification),
    badge("tier", `tier ${entry.tier}`),
    badge("family", entry.family),
  ].join(" ");

  // Provenance block
  const prov = [];
  prov.push(`<dl class="provenance">`);
  prov.push(`<dt>Source</dt><dd><a href="${esc(entry.source_url)}">${esc(entry.source_url)}</a></dd>`);
  prov.push(`<dt>Version</dt><dd>${esc(entry.source_version)}</dd>`);
  prov.push(`<dt>Retrieved</dt><dd>${esc(entry.retrieved_date)}</dd>`);
  prov.push(`<dt>Updated</dt><dd>${esc(entry.updated)}</dd>`);
  prov.push(`</dl>`);
  if (Array.isArray(entry.attribution) && entry.attribution.length) {
    const items = entry.attribution
      .map((a) => {
        const ref = a.claim_ref ? `<code>${esc(a.claim_ref)}</code> ` : "";
        return `<li>${ref}<a href="${esc(a.source_url)}">${esc(a.source_url)}</a> <span class="ver">(${esc(a.source_version)})</span>${a.note ? `<br><span class="note">${esc(a.note)}</span>` : ""}</li>`;
      })
      .join("\n");
    prov.push(`<details class="attribution" open><summary>Per-claim attribution (${entry.attribution.length})</summary>\n<ul>${items}</ul>\n</details>`);
  }

  const aliases = Array.isArray(entry.aliases) && entry.aliases.length
    ? `<p class="aliases"><strong>Also known as:</strong> ${entry.aliases.map((a) => esc(a)).join(", ")}</p>`
    : "";

  const seeAlso = Array.isArray(entry.see_also) && entry.see_also.length
    ? `<section><h2>See also</h2>\n<ul class="see-also">${entry.see_also.map((id) => `<li><a href="/${esc(id)}">${esc(id)}</a></li>`).join("\n")}</ul>\n</section>`
    : "";

  const body = `      <article class="entry">
        <p class="crumbs"><a href="/">home</a> / <a href="/${esc(entry.family)}/">${esc(entry.family)}</a> / ${esc(entry.slug)}</p>
        <h1>${esc(entry.title)}</h1>
        <p class="badges">${badges}</p>
        <p class="summary">${esc(entry.summary)}</p>
        ${aliases}
        <section><h2>Provenance</h2>
        ${prov.join("\n")}
        </section>
        ${renderExt(entry)}
        ${seeAlso}
        <p class="rawlink"><a href="/${esc(entry.id)}.json">Raw JSON</a></p>
      </article>`;

  return page({
    title: `${entry.title} — ${SITE_NAME}`,
    description: entry.summary,
    jsonAlternate: `/${entry.id}.json`,
    body,
    bodyClass: "entry-page",
  });
}

// ---------------------------------------------------------------------------
// Family landing page
// ---------------------------------------------------------------------------

function renderFamilyPage(family, rows) {
  const label = FAMILY_VOCAB[family] || family;
  const items = rows
    .map(
      (r) =>
        `<li><a href="/${esc(r.id)}">${esc(r.title)}</a> ${badge("verification", r.verification)} ${badge("status", r.status)}</li>`
    )
    .join("\n");
  const body = `      <p class="crumbs"><a href="/">home</a> / ${esc(family)}</p>
      <h1>${esc(family)}</h1>
      <p class="summary">${esc(label)}</p>
      <input type="search" id="q" class="search" placeholder="Filter ${esc(family)}…" autocomplete="off" data-family="${esc(family)}">
      <ul class="entry-list" id="results">
${items}
      </ul>
      <script src="/assets/app.js" defer></script>`;
  return page({
    title: `${family} — ${SITE_NAME}`,
    description: label,
    jsonAlternate: `/${family}/index.json`,
    body,
    bodyClass: "family-page",
  });
}

// ---------------------------------------------------------------------------
// Home page
// ---------------------------------------------------------------------------

function renderHomePage(families) {
  const famItems = families
    .map(
      (f) =>
        `<li><a href="/${esc(f.family)}/">${esc(f.family)}</a> <span class="count">${f.count}</span><br><span class="note">${esc(FAMILY_VOCAB[f.family] || "")}</span></li>`
    )
    .join("\n");
  const body = `      <h1>${esc(SITE_NAME)}</h1>
      <blockquote class="purpose">${esc(SITE_PURPOSE)}</blockquote>
      <input type="search" id="q" class="search" placeholder="Search protocols…" autocomplete="off" autofocus>
      <ul class="entry-list" id="results"></ul>
      <h2>Families</h2>
      <ul class="family-list">
${famItems}
      </ul>
      <h2>For agents</h2>
      <p>Add <code>.json</code> to any entry path, or send <code>Accept: application/json</code>, to get the canonical entry bytes. The token-lean index is <a href="/llms.txt">/llms.txt</a>; full inlined context is <a href="/llms-full.txt">/llms-full.txt</a>.</p>
      <script src="/assets/app.js" defer></script>`;
  return page({
    title: SITE_NAME,
    description: SITE_PURPOSE,
    jsonAlternate: `/index.json`,
    body,
    bodyClass: "home-page",
  });
}

// ---------------------------------------------------------------------------
// llms.txt / llms-full.txt
// ---------------------------------------------------------------------------

function renderLlmsTxt(families) {
  const lines = [];
  lines.push(`# ${SITE_NAME}`);
  lines.push("");
  lines.push(`> ${SITE_PURPOSE}`);
  lines.push("");
  lines.push(`## How to use this site (agent contract)`);
  lines.push("");
  lines.push(`- Canonical id == permalink path: \`{family}[/{namespace}]/{slug}\` (e.g. \`terminal-osc/133\`).`);
  lines.push(`- Content negotiation: send \`Accept: application/json\` on a bare path, OR append a \`.json\` suffix, to get the canonical entry bytes. A bare path with an HTML Accept gives the rendered page.`);
  lines.push(`- Under-specified guesses and aliases 301-redirect to the canonical id (see /redirects.json).`);
  lines.push(`- Do not use full-text search; enumerate the per-family manifests below and fetch entries by constructed id.`);
  lines.push(`- Canonical agent entry point: fetch \`/{id}.json\` for any entry; start from a family manifest \`/{family}/index.json\`.`);
  lines.push("");
  lines.push(`## Family vocabulary`);
  lines.push("");
  for (const f of families) {
    lines.push(`- \`${f.family}\` (${f.count}) — ${FAMILY_VOCAB[f.family] || ""}`);
  }
  lines.push("");
  lines.push(`## Per-family manifests`);
  lines.push("");
  for (const f of families) {
    lines.push(`- /${f.family}/index.json`);
  }
  lines.push("");
  lines.push(`## Root manifest`);
  lines.push("");
  lines.push(`- /index.json — family vocabulary + counts + links`);
  lines.push(`- /search-index.json — searchable (verified) entries only`);
  lines.push("");
  return lines.join("\n");
}

function renderLlmsFullTxt(entries) {
  const lines = [];
  lines.push(`# ${SITE_NAME} — full index`);
  lines.push("");
  lines.push(`> ${SITE_PURPOSE}`);
  lines.push("");
  // Group by family for readability.
  const byFamily = new Map();
  for (const e of entries) {
    if (!byFamily.has(e.family)) byFamily.set(e.family, []);
    byFamily.get(e.family).push(e);
  }
  for (const [family, list] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${family}`);
    lines.push("");
    for (const e of list) {
      lines.push(`### ${e.title}`);
      lines.push(`id: ${e.id}`);
      lines.push(e.summary);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// redirects.json — derived from aliases + curated guesses
// ---------------------------------------------------------------------------

function buildRedirects(entries) {
  const redirects = {};
  for (const e of entries) {
    // Curated guess: bare slug -> canonical id (e.g. /418 -> /http-status/418,
    // /133 collides across families, so only mint when unambiguous below).
    // Alias-derived: kebab the alias into a guessable path under the family.
    // We key everything as leading-slash paths.
    // Short-id guess: '/{namespace?}/{slug}' without the family, e.g.
    // /osc/133 -> /terminal-osc/133.
    if (e.family.startsWith("terminal-")) {
      const short = e.family.replace(/^terminal-/, "");
      redirects[`/${short}/${e.slug}`] = `/${e.id}`;
    }
  }

  // Bare-slug guesses: only when the slug is globally unique across all entries.
  const slugCount = new Map();
  for (const e of entries) slugCount.set(e.slug, (slugCount.get(e.slug) || 0) + 1);
  for (const e of entries) {
    if (slugCount.get(e.slug) === 1) {
      redirects[`/${e.slug}`] = `/${e.id}`;
    }
  }
  return redirects;
}

// ---------------------------------------------------------------------------
// Writer helpers
// ---------------------------------------------------------------------------

const written = [];
async function emit(relPath, contents) {
  const full = path.join(DIST, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents);
  written.push(relPath);
}

function prettyJson(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Fresh dist.
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const loaded = await loadEntries();
  const validator = await buildValidator();
  if (!validator) {
    console.warn("[build] ajv not installed — skipping schema validation. Run `npm i` for the gate.");
  }

  const entries = [];
  const errors = [];
  for (const { file, entry } of loaded) {
    // Validate id <-> family/namespace/slug coherence.
    const expectedId = entry.namespace
      ? `${entry.family}/${entry.namespace}/${entry.slug}`
      : `${entry.family}/${entry.slug}`;
    if (entry.id !== expectedId) {
      errors.push(`${file}: id '${entry.id}' != derived '${expectedId}'`);
    }
    if (validator) {
      if (!validator.validateCore(entry)) {
        errors.push(`${file}: core schema: ${JSON.stringify(validator.validateCore.errors)}`);
      }
      const extV = validator.extSchemas[entry.ext_type];
      if (extV && !extV(entry.ext)) {
        errors.push(`${file}: ext schema ${entry.ext_type}: ${JSON.stringify(extV.errors)}`);
      }
    }
    entries.push(entry);
  }
  if (errors.length) {
    console.error("[build] validation errors:");
    for (const e of errors) console.error("  - " + e);
    throw new Error(`${errors.length} validation error(s); aborting build.`);
  }

  // Sort entries for deterministic output.
  entries.sort((a, b) => a.id.localeCompare(b.id));

  // Group by family.
  const byFamily = new Map();
  for (const e of entries) {
    if (!byFamily.has(e.family)) byFamily.set(e.family, []);
    byFamily.get(e.family).push(e);
  }

  // Per-entry: canonical JSON + rendered HTML.
  for (const e of entries) {
    await emit(`${e.id}.json`, prettyJson(e));
    await emit(`${e.id}/index.html`, renderEntryPage(e));
  }

  // Per-family: manifest + landing page.
  const familySummaries = [];
  for (const [family, list] of [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    const manifest = {
      family,
      label: FAMILY_VOCAB[family] || family,
      count: sorted.length,
      entries: sorted.map(manifestRow),
    };
    await emit(`${family}/index.json`, prettyJson(manifest));
    await emit(
      `${family}/index.html`,
      renderFamilyPage(
        family,
        sorted.map((e) => ({ id: e.id, title: e.title, status: e.status, verification: e.verification }))
      )
    );
    familySummaries.push({ family, count: sorted.length });
  }

  // Root manifest. Includes the full closed vocabulary, marking which are
  // populated, so agents see the family enum even before coverage lands.
  const vocab = Object.keys(FAMILY_VOCAB).map((family) => {
    const present = byFamily.get(family);
    return {
      family,
      label: FAMILY_VOCAB[family],
      count: present ? present.length : 0,
      manifest: present ? `/${family}/index.json` : null,
    };
  });
  const rootManifest = {
    name: SITE_NAME,
    purpose: SITE_PURPOSE,
    generated: TODAY,
    total_entries: entries.length,
    families: vocab,
    links: {
      search_index: "/search-index.json",
      redirects: "/redirects.json",
      llms: "/llms.txt",
      llms_full: "/llms-full.txt",
    },
  };
  await emit(`index.json`, prettyJson(rootManifest));
  await emit(`index.html`, renderHomePage(familySummaries));

  // Search index: verified-or-contested only (verification != 'unverified').
  // Trust beats breadth.
  const searchIndex = entries
    .filter((e) => e.verification !== "unverified")
    .map(searchRow);
  await emit(`search-index.json`, prettyJson(searchIndex));

  // Agent indexes.
  await emit(`llms.txt`, renderLlmsTxt(familySummaries));
  await emit(`llms-full.txt`, renderLlmsFullTxt(entries));

  // Redirects.
  await emit(`redirects.json`, prettyJson(buildRedirects(entries)));

  // Static assets.
  if (existsSync(ASSETS_SRC)) {
    await cp(ASSETS_SRC, path.join(DIST, "assets"), { recursive: true });
    for (const name of await readdir(ASSETS_SRC)) written.push(`assets/${name}`);
  }

  written.sort();
  console.log(`[build] ${entries.length} entr${entries.length === 1 ? "y" : "ies"} → ${written.length} files in dist/`);
  for (const w of written) console.log("  " + w);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
