// wire data-integrity gates — run with: bun run scripts/gates/run-all.ts
// Five deterministic checks over /data. Not a conformance harness; this verifies
// the data we SERVE is well-formed, cited, and internally correct.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import punycode from "node:punycode";

const ENUMS = {
  family: ["terminal-osc", "terminal-csi", "terminal-dec-private-mode", "http-status", "http-method", "media-type", "uri-scheme", "port", "tls-param", "dns-rrtype", "cbor-tag", "encoding"],
  kind: ["control-sequence", "status-code", "method", "media-type", "scheme", "port", "parameter", "rrtype", "tag", "encoding"],
  status: ["standard", "de-facto", "proprietary", "experimental", "deprecated", "obsolete", "reserved", "unassigned"],
  verification: ["verified", "unverified", "contested"],
  tier: ["A", "B", "C"],
  ext_type: ["terminal-escape@1", "iana-registry-row@1", "encoding@1"],
} as const;
const REQUIRED = ["id", "family", "slug", "title", "summary", "kind", "status", "verification", "tier", "source_url", "source_version", "retrieved_date", "ext_type", "ext", "updated"];

interface Entry { [k: string]: any }
function load(): { file: string; e: Entry }[] {
  const out: { file: string; e: Entry }[] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith(".json")) out.push({ file: p, e: JSON.parse(readFileSync(p, "utf8")) });
    }
  };
  walk("data");
  return out;
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return ""; } };

type Fail = { id: string; msg: string };
type Gate = { name: string; run: (rows: { file: string; e: Entry }[]) => Fail[]; note?: string };

// ── gate 1: schema (structural) ─────────────────────────────────
const gSchema: Gate = {
  name: "schema",
  run: (rows) => {
    const f: Fail[] = [];
    for (const { e } of rows) {
      for (const k of REQUIRED) if (e[k] === undefined) f.push({ id: e.id ?? "?", msg: `missing ${k}` });
      for (const [k, allowed] of Object.entries(ENUMS))
        if (e[k] !== undefined && !(allowed as readonly string[]).includes(e[k])) f.push({ id: e.id, msg: `${k}="${e[k]}" not in enum` });
      if (e.tier === "C" && !(Array.isArray(e.attribution) && e.attribution.length >= 1)) f.push({ id: e.id, msg: "tier C requires attribution[]" });
      const ext = e.ext ?? {};
      if (e.ext_type === "terminal-escape@1") { for (const k of ["csi_or_osc", "terminator", "params"]) if (ext[k] === undefined) f.push({ id: e.id, msg: `ext missing ${k}` }); }
      if (e.ext_type === "encoding@1") { for (const k of ["rfc", "test_vectors"]) if (ext[k] === undefined) f.push({ id: e.id, msg: `ext missing ${k}` }); }
      if (e.ext_type === "iana-registry-row@1" && ext.raw_columns === undefined) f.push({ id: e.id, msg: "ext missing raw_columns" });
    }
    return f;
  },
};

// ── gate 2: provenance-lint ─────────────────────────────────────
const gProv: Gate = {
  name: "provenance-lint",
  run: (rows) => {
    const f: Fail[] = [];
    for (const { e } of rows) {
      for (const k of ["source_url", "source_version", "retrieved_date"]) if (!e[k]) f.push({ id: e.id, msg: `empty ${k}` });
      if (e.source_url && !hostOf(e.source_url)) f.push({ id: e.id, msg: "source_url unparseable" });
      const multi = e.tier === "C" || (Array.isArray(e.attribution) && e.attribution.length > 0);
      if (e.tier === "C" && !(Array.isArray(e.attribution) && e.attribution.length)) f.push({ id: e.id, msg: "tier C needs attribution[]" });
      if (multi) for (const a of e.attribution ?? []) if (!a.source_url || !a.source_version) f.push({ id: e.id, msg: "attribution row missing source_url/version" });
    }
    return f;
  },
};

// ── gate 3: tier-a-roundtrip (lightweight shape) ────────────────
const gTierA: Gate = {
  name: "tier-a-roundtrip",
  note: "",
  run: (rows) => {
    const f: Fail[] = [];
    let n = 0;
    // Scope to IANA-sourced rows (ext_type iana-registry-row@1). Other tier-A
    // entries (e.g. encoding@1, verified by encoding-exec) are out of scope here.
    for (const { e } of rows) {
      if (e.ext_type !== "iana-registry-row@1") continue;
      n++;
      const rc = e.ext?.raw_columns;
      if (!rc || (typeof rc === "object" && Object.keys(rc).length === 0)) f.push({ id: e.id, msg: "empty raw_columns" });
      if (!hostOf(e.source_url).endsWith("iana.org")) f.push({ id: e.id, msg: "source_url not iana.org" });
    }
    gTierA.note = `${n} iana-registry-row entries checked (full re-fetch deferred to nightly ingest)`;
    return f;
  },
};

// ── gate 4: encoding-exec (runs code) ───────────────────────────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32enc(buf: Buffer): string { let bits = 0, val = 0, o = ""; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { o += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) o += B32[(val << (5 - bits)) & 31]; while (o.length % 8 !== 0) o += "="; return o; }
function b32dec(s: string): Buffer { s = s.replace(/=+$/, "").toUpperCase(); let bits = 0, val = 0; const o: number[] = []; for (const c of s) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { o.push((val >>> (bits - 8)) & 0xff); bits -= 8; } } return Buffer.from(o); }
const UNRES = /[A-Za-z0-9\-._~]/;
function pctEnc(buf: Buffer): string { let o = ""; for (const b of buf) { const c = String.fromCharCode(b); o += UNRES.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0"); } return o; }
function inputBytes(v: any): Buffer { const enc = v.input_encoding || (v.input_form === "literal" ? "latin1" : v.input_form === "ascii" ? "ascii" : "utf8"); return Buffer.from(v.input, enc as BufferEncoding); }

const gEnc: Gate = {
  name: "encoding-exec",
  note: "",
  run: (rows) => {
    const f: Fail[] = [];
    let n = 0;
    for (const { e } of rows) {
      if (e.ext_type !== "encoding@1") continue;
      for (const v of e.ext.test_vectors ?? []) {
        n++;
        try {
          let got: string;
          if (v.direction === "encode") {
            const buf = inputBytes(v);
            got = v.algorithm === "base64" ? buf.toString("base64")
              : v.algorithm === "base64url" ? buf.toString("base64url")
              : v.algorithm === "base16" ? buf.toString("hex")
              : v.algorithm === "base32" ? b32enc(buf)
              : v.algorithm === "percent" ? pctEnc(buf)
              : v.algorithm === "punycode" ? punycode.toASCII(buf.toString("utf8"))
              : "?";
          } else {
            const s = String(v.input);
            const buf = v.algorithm === "base64" ? Buffer.from(s, "base64")
              : v.algorithm === "base64url" ? Buffer.from(s, "base64url")
              : v.algorithm === "base16" ? Buffer.from(s, "hex")
              : v.algorithm === "base32" ? b32dec(s)
              : null;
            got = v.algorithm === "percent" ? decodeURIComponent(s)
              : v.algorithm === "punycode" ? punycode.toUnicode(s)
              : buf!.toString((v.output_form === "utf8" ? "utf8" : "utf8") as BufferEncoding);
          }
          const eq = v.algorithm === "base16" ? got.toLowerCase() === String(v.output).toLowerCase() : got === v.output;
          if (!eq) f.push({ id: e.id, msg: `${v.algorithm} ${v.direction}: got "${got}" want "${v.output}"` });
        } catch (err) { f.push({ id: e.id, msg: `${v.algorithm} ${v.direction} threw: ${err}` }); }
      }
    }
    gEnc.note = `${n} encoding test-vectors executed`;
    return f;
  },
};

// ── gate 5: quorum-lint ─────────────────────────────────────────
const gQuorum: Gate = {
  name: "quorum-lint",
  run: (rows) => {
    const f: Fail[] = [];
    for (const { e } of rows) {
      if (e.tier !== "C") continue;
      const hosts = new Set<string>([hostOf(e.source_url), ...(e.attribution ?? []).map((a: any) => hostOf(a.source_url))].filter(Boolean));
      if (hosts.size < 2 && e.verification === "verified") f.push({ id: e.id, msg: `tier C "verified" but only ${hosts.size} distinct source host(s)` });
    }
    return f;
  },
};

// ── run ─────────────────────────────────────────────────────────
const rows = load();
const gates = [gSchema, gProv, gTierA, gEnc, gQuorum];
console.log(`wire data-integrity gates  (entries: ${rows.length})`);
console.log("=".repeat(56));
let total = 0;
const summary: any[] = [];
for (const g of gates) {
  const fails = g.run(rows);
  total += fails.length;
  console.log(`[${fails.length ? "FAIL" : "PASS"}] ${g.name}  (${fails.length} failure(s))`);
  if (g.note) console.log(`        note: ${g.note}`);
  for (const x of fails.slice(0, 10)) console.log(`        ${x.id}: ${x.msg}`);
  if (fails.length > 10) console.log(`        … +${fails.length - 10} more`);
  summary.push({ name: g.name, ok: fails.length === 0, failures: fails.length });
}
console.log("=".repeat(56));
console.log("SUMMARY", JSON.stringify({ ok: total === 0, entries_checked: rows.length, total_failures: total, gates: summary }));
process.exit(total === 0 ? 0 : 1);
