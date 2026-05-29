// wire data-integrity gates — run with: bun run scripts/gates/run-all.ts
// Five deterministic checks over /data. Not a conformance harness; this verifies
// the data we SERVE is well-formed, cited, and internally correct.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import punycode from "node:punycode";

const ENUMS = {
  family: ["terminal-osc", "terminal-csi", "terminal-dec-private-mode", "http-status", "http-method", "media-type", "uri-scheme", "port", "tls-param", "dns-rrtype", "cbor-tag", "encoding", "http-header", "link-relation", "well-known-uri", "identifier", "magic", "wire-format"],
  kind: ["control-sequence", "status-code", "method", "media-type", "scheme", "port", "parameter", "rrtype", "tag", "encoding", "header", "link-relation", "well-known-uri", "identifier", "signature", "wire-format"],
  status: ["standard", "de-facto", "proprietary", "experimental", "deprecated", "obsolete", "reserved", "unassigned"],
  verification: ["verified", "unverified", "contested"],
  tier: ["A", "B", "C"],
  ext_type: ["terminal-escape@1", "iana-registry-row@1", "encoding@1", "identifier@1", "file-signature@1", "wire-format@1"],
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
      if (e.ext_type === "identifier@1") { for (const k of ["spec", "example"]) if (ext[k] === undefined) f.push({ id: e.id, msg: `ext missing ${k}` }); }
      if (e.ext_type === "file-signature@1") { for (const k of ["magic_hex", "extensions"]) if (ext[k] === undefined) f.push({ id: e.id, msg: `ext missing ${k}` }); }
      if (e.ext_type === "wire-format@1") { if (ext.spec === undefined) f.push({ id: e.id, msg: "ext missing spec" }); }
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
import { createHash } from "node:crypto";

// Generic RFC 4648 base32 family, parameterized by alphabet + padding so the
// standard alphabet, base32hex, and z-base-32 all share one proven core.
function b32encA(buf: Buffer, alpha: string, pad: boolean): string { let bits = 0, val = 0, o = ""; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { o += alpha[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) o += alpha[(val << (5 - bits)) & 31]; if (pad) while (o.length % 8 !== 0) o += "="; return o; }
function b32decA(s: string, alpha: string): Buffer { s = s.replace(/=+$/, ""); let bits = 0, val = 0; const o: number[] = []; for (const c of s) { const i = alpha.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { o.push((val >>> (bits - 8)) & 0xff); bits -= 8; } } return Buffer.from(o); }
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";
const ZB32 = "ybndrfg8ejkmcpqxot1uwisza345h769";
const b32enc = (buf: Buffer) => b32encA(buf, B32, true);
const b32dec = (s: string) => b32decA(s.toUpperCase(), B32);

const UNRES = /[A-Za-z0-9\-._~]/;
function pctEnc(buf: Buffer): string { let o = ""; for (const b of buf) { const c = String.fromCharCode(b); o += UNRES.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0"); } return o; }
function inputBytes(v: any): Buffer { const enc = v.input_encoding || (v.input_form === "literal" ? "latin1" : v.input_form === "ascii" ? "ascii" : "utf8"); return Buffer.from(v.input, enc as BufferEncoding); }

// ── base58 (Bitcoin alphabet) — big-int base conversion + leading-zero rule ──
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(buf: Buffer): string { let zeros = 0; while (zeros < buf.length && buf[zeros] === 0) zeros++; let n = 0n; for (const b of buf) n = n * 256n + BigInt(b); let o = ""; while (n > 0n) { o = B58[Number(n % 58n)] + o; n /= 58n; } return "1".repeat(zeros) + o; }
function b58dec(s: string): Buffer { let zeros = 0; while (zeros < s.length && s[zeros] === "1") zeros++; let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) throw new Error(`bad base58 char ${c}`); n = n * 58n + BigInt(i); } const bytes: number[] = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; } return Buffer.concat([Buffer.alloc(zeros), Buffer.from(bytes)]); }
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
function b58checkEnc(payload: Buffer): string { const chk = sha256(sha256(payload)).subarray(0, 4); return b58enc(Buffer.concat([payload, chk])); }
function b58checkDec(s: string): Buffer { const full = b58dec(s); const payload = full.subarray(0, full.length - 4); const chk = full.subarray(full.length - 4); const want = sha256(sha256(payload)).subarray(0, 4); if (!chk.equals(want)) throw new Error("base58check bad checksum"); return Buffer.from(payload); }

// ── quoted-printable (RFC 2045 §6.7, minimal: escape non-printable, '=', and 8-bit) ──
function qpEnc(buf: Buffer): string { let o = ""; for (const b of buf) { if (b === 0x3d || b < 0x20 || b > 0x7e) o += "=" + b.toString(16).toUpperCase().padStart(2, "0"); else o += String.fromCharCode(b); } return o; }
function qpDec(s: string): Buffer { const o: number[] = []; for (let i = 0; i < s.length; i++) { if (s[i] === "=") { if (s[i + 1] === "\r" || s[i + 1] === "\n") { while (s[i + 1] === "\r" || s[i + 1] === "\n") i++; continue; } o.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; } else o.push(s.charCodeAt(i)); } return Buffer.from(o); }

// ── ascii85 (Adobe/btoa flavor: 5 chars per 4 bytes, 'z' shortcut for zero group) ──
function a85enc(buf: Buffer): string { let o = ""; for (let i = 0; i < buf.length; i += 4) { const chunk = buf.subarray(i, i + 4); const n = chunk.length; let val = 0; for (let j = 0; j < 4; j++) val = (val * 256 + (j < n ? chunk[j] : 0)) >>> 0; if (n === 4 && val === 0) { o += "z"; continue; } const grp: string[] = []; let v = val; for (let j = 0; j < 5; j++) { grp.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); } o += grp.join("").slice(0, n + 1); } return o; }
function a85dec(s: string): Buffer { const out: number[] = []; let group: number[] = []; const flush = (count: number) => { while (group.length < 5) group.push(84); let val = 0; for (const d of group) val = val * 85 + d; const bytes = [(val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff]; for (let k = 0; k < count - 1; k++) out.push(bytes[k]); group = []; }; for (const ch of s) { if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; } if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue; group.push(ch.charCodeAt(0) - 33); if (group.length === 5) flush(5); } if (group.length > 0) flush(group.length); return Buffer.from(out); }

// ── base45 (RFC 9285): pairs of bytes -> 3 base45 chars (LSB-first), trailing byte -> 2 chars ──
const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
function b45enc(buf: Buffer): string { let o = ""; for (let i = 0; i < buf.length; i += 2) { if (i + 1 < buf.length) { const n = buf[i] * 256 + buf[i + 1]; const c = n % 45, d = Math.floor(n / 45) % 45, e = Math.floor(n / 2025); o += B45[c] + B45[d] + B45[e]; } else { const n = buf[i]; const c = n % 45, d = Math.floor(n / 45); o += B45[c] + B45[d]; } } return o; }
function b45dec(s: string): Buffer { const out: number[] = []; for (let i = 0; i < s.length; ) { if (i + 3 <= s.length && s.length - i !== 2) { const n = B45.indexOf(s[i]) + B45.indexOf(s[i + 1]) * 45 + B45.indexOf(s[i + 2]) * 2025; out.push((n >>> 8) & 0xff, n & 0xff); i += 3; } else { const n = B45.indexOf(s[i]) + B45.indexOf(s[i + 1]) * 45; out.push(n & 0xff); i += 2; } } return Buffer.from(out); }

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
              : v.algorithm === "base32hex" ? b32encA(buf, B32HEX, true)
              : v.algorithm === "z-base-32" ? b32encA(buf, ZB32, false)
              : v.algorithm === "base58" ? b58enc(buf)
              : v.algorithm === "base58check" ? b58checkEnc(buf)
              : v.algorithm === "base45" ? b45enc(buf)
              : v.algorithm === "ascii85" ? a85enc(buf)
              : v.algorithm === "quoted-printable" ? qpEnc(buf)
              : v.algorithm === "percent" ? pctEnc(buf)
              : v.algorithm === "punycode" ? punycode.toASCII(buf.toString("utf8"))
              : "?";
          } else {
            const s = String(v.input);
            const buf = v.algorithm === "base64" ? Buffer.from(s, "base64")
              : v.algorithm === "base64url" ? Buffer.from(s, "base64url")
              : v.algorithm === "base16" ? Buffer.from(s, "hex")
              : v.algorithm === "base32" ? b32dec(s)
              : v.algorithm === "base32hex" ? b32decA(s.toUpperCase(), B32HEX)
              : v.algorithm === "z-base-32" ? b32decA(s, ZB32)
              : v.algorithm === "base58" ? b58dec(s)
              : v.algorithm === "base58check" ? b58checkDec(s)
              : v.algorithm === "base45" ? b45dec(s)
              : v.algorithm === "ascii85" ? a85dec(s)
              : v.algorithm === "quoted-printable" ? qpDec(s)
              : null;
            got = v.algorithm === "percent" ? decodeURIComponent(s)
              : v.algorithm === "punycode" ? punycode.toUnicode(s)
              : v.output_form === "bytes-hex" ? buf!.toString("hex").toUpperCase()
              : buf!.toString("utf8");
          }
          const eq = (v.algorithm === "base16" || v.output_form === "bytes-hex") ? got.toLowerCase() === String(v.output).toLowerCase() : got === v.output;
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
