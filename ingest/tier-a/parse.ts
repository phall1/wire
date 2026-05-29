// ingest/tier-a/parse.ts — DETERMINISTIC Tier-A parser + row->entry mapper.
//
// No LLM is ever in the Tier-A loop (DESIGN §2). This module:
//   1. parseCSV(text)        — an RFC4180 parser (quoted fields, embedded
//                              commas, "" escaped quotes, CRLF/LF, bracketed
//                              RFC refs that contain commas like "[RFC9110, S15]").
//   2. mapRow(...)           — turns one registry row into a full core+ext entry
//                              (ext_type iana-registry-row@1), or null if the row
//                              is curated out (with a logged reason).
//   3. parseRegistry(...)    — parse a CSV string for one registry into
//                              { entries, included, excluded } with an audit log.
//   4. parseFamily(family)   — the cli.ts contract: read the cached CSV that
//                              run.ts fetched (.cache/tier-a/<id>.csv) and
//                              its captured Last-Modified, parse, return entries.
//
// Byte sequences never appear here; IANA rows are plain text. retrieved_date and
// `updated` are the pinned literal '2026-05-29' (never computed at runtime).

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
// Cache lives OUTSIDE data/ so the build (which walks data/**/*.json as entries)
// never tries to parse the cached CSVs/meta as protocol entries.
const CACHE_DIR = join(REPO_ROOT, '.cache', 'tier-a');
const CONFIG_PATH = join(REPO_ROOT, 'ingest', 'registries.config.json');

export const TODAY = '2026-05-29'; // pinned literal per the build contract.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One registry entry from ingest/registries.config.json. */
export interface RegistryConfig {
  url: string;
  format: string;
  family: string;
  namespace?: string;
  ext_type: string;
  slug_column: string;
  kind?: string;
  notes?: string;
}

/** The registries map keyed by registry id. */
export type RegistryMap = Record<string, RegistryConfig>;

/** A parsed CSV row: header -> cell, loosely shaped. */
export type Row = Record<string, string>;

/** ext block on a Tier-A iana-registry-row@1 entry. Loosely shaped per family. */
export interface EntryExt {
  value: number | string;
  reference_rfcs: string[];
  raw_columns: Record<string, string>;
  registration_date?: string;
  recommended?: boolean | string;
  dtls_ok?: boolean | string;
  transports?: string[];
  [k: string]: unknown;
}

/** A full Tier-A core+ext entry. */
export interface Entry {
  id: string;
  family: string;
  namespace?: string;
  slug: string;
  title: string;
  summary: string;
  kind: string;
  status: string;
  verification: string;
  tier: string;
  source_url: string;
  source_version: string;
  retrieved_date: string;
  ext_type: string;
  ext: EntryExt;
  updated: string;
  aliases?: string[];
}

/** Result of mapping a single row: either an entry or a skip reason. */
export type MapResult = { entry: Entry; skip?: undefined } | { entry?: undefined; skip: string };

/** An excluded-row audit record. */
export interface Excluded {
  id?: string;
  row?: string;
  reason: string;
}

/** The result of parsing one registry's CSV. */
export interface ParseResult {
  entries: Entry[];
  included: string[];
  excluded: Excluded[];
  totalRows: number;
  consideredRows?: number;
}

// ---------------------------------------------------------------------------
// 1. RFC4180 CSV parser
// ---------------------------------------------------------------------------

/**
 * Parse RFC4180 CSV text into an array of row objects keyed by the header row.
 * Handles: quoted fields, embedded commas inside quotes (the bracketed RFC refs
 * like "[RFC9110, Section 15.2.1]"), doubled "" as an escaped quote, embedded
 * newlines inside quotes, and CRLF or LF line endings. A trailing newline does
 * not yield a spurious empty row.
 *
 * Returns { headers: string[], rows: Array<Record<string,string>> }.
 */
export function parseCSV(text: string): { headers: string[]; rows: Row[] } {
  // Normalize a leading UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let sawAnyChar = false;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; sawAnyChar = true; i++; continue; }
    if (c === ',') { endField(); sawAnyChar = true; i++; continue; }
    if (c === '\r') {
      // CRLF or lone CR -> record boundary.
      endRecord();
      if (text[i + 1] === '\n') i += 2; else i++;
      sawAnyChar = false;
      continue;
    }
    if (c === '\n') {
      endRecord();
      i++;
      sawAnyChar = false;
      continue;
    }
    field += c; sawAnyChar = true; i++;
  }
  // Flush the final record if the file did not end with a newline, or if we were
  // mid-field. A clean trailing newline leaves field='' and sawAnyChar=false ->
  // no spurious empty record.
  if (sawAnyChar || field.length > 0 || record.length > 0) endRecord();

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0];
  const rows: Row[] = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    // Skip fully-empty trailing records.
    if (rec.length === 1 && rec[0] === '') continue;
    const obj: Row = {};
    for (let h = 0; h < headers.length; h++) obj[headers[h]] = rec[h] ?? '';
    rows.push(obj);
  }
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// 2. Reference / RFC parsing
// ---------------------------------------------------------------------------

/**
 * Extract normalized RFC tokens from a registry Reference cell.
 * Inputs look like: "[RFC9110, Section 15.2.1]", "[RFC5246][RFC-ietf-...]",
 * "[RFC1035]", "[Jon_Postel]" (a person, not an RFC), "[draft-...]".
 * Returns e.g. ['RFC9110'] — only canonical published RFC numbers, deduped, in
 * first-seen order. Drafts and personal/registrant refs are intentionally NOT
 * RFC tokens (they stay verbatim in raw_columns).
 */
export function parseRfcRefs(refCell: string): string[] {
  if (!refCell) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Match RFC followed by digits, but NOT 'RFC-ietf-...' draft handles.
  const re = /RFC[\s-]?(\d{3,5})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(refCell)) !== null) {
    // Reject the draft form 'RFC-ietf-tls-...': there the char after 'RFC-' is a
    // non-digit, so the \d{3,5} would not match there anyway. Guard the hyphen
    // case explicitly: 'RFC-9110' is unusual but treat as RFC9110.
    const tok = 'RFC' + m[1];
    if (!seen.has(tok)) { seen.add(tok); out.push(tok); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Curation predicates + slug derivation, per family
// ---------------------------------------------------------------------------

const UNASSIGNED_RE = /^(unassigned|reserved|private use|unallocated)$/i;

/**
 * Slugify a free-form natural-key TOKEN (uri scheme, http method, dns mnemonic)
 * into the core id charset [A-Za-z0-9._-], deterministically and reversibly via
 * the kept `value` / raw_columns + an alias. The frozen core id pattern forbids
 * '+', '*', whitespace and parentheses, which a few rows carry. Returns null if
 * the token is empty after cleaning. The original token is preserved verbatim in
 * raw_columns and surfaced as an alias so it stays discoverable.
 *   'coap+tcp'         -> 'coap-tcp'   (alias 'coap+tcp')
 *   'shttp (OBSOLETE)' -> 'shttp'      (alias 'shttp (OBSOLETE)')
 *   '*'                -> 'wildcard'   (alias '*')
 */
export function slugifyKey(token: string): { slug: string; changed: boolean } | null {
  let t = String(token).trim();
  // Drop a trailing parenthetical qualifier like ' (OBSOLETE)'.
  t = t.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (t === '*') return { slug: 'wildcard', changed: true };
  const slug = t.replace(/\+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  return { slug, changed: slug !== String(token).trim() };
}

// Classic / commonly-deployed suites always kept for tls cipher-suites even if
// the upstream Recommended column != 'Y'. Curated so the corpus covers the suites
// a practitioner actually configures (TLS 1.3 + the standard TLS 1.2 ECDHE/DHE/
// RSA families) rather than only the 14 the registry flags Recommended=Y. Each
// slug is the concatenated IANA hex value (verified present in the registry).
const TLS_CLASSIC_SLUGS = new Set<string>([
  // TLS 1.3 (RFC 8446)
  '0x1301', '0x1302', '0x1303', '0x1304', '0x1305',
  // TLS 1.2 ECDHE-ECDSA / ECDHE-RSA AEAD (GCM)
  '0xc02b', '0xc02c', '0xc02f', '0xc030',
  // TLS 1.2 ECDHE CBC (SHA1 + SHA256/384)
  '0xc009', '0xc00a', '0xc013', '0xc014',
  '0xc023', '0xc024', '0xc027', '0xc028',
  // ChaCha20-Poly1305 (ECDHE + DHE)
  '0xcca8', '0xcca9', '0xccaa',
  // DHE-RSA AEAD + CBC
  '0x009e', '0x009f', '0x0033', '0x0039',
  // Classic RSA kex (GCM / CBC / legacy 3DES)
  '0x009c', '0x009d', '0x002f', '0x0035', '0x003c', '0x003d', '0x000a',
]);

/**
 * Build the per-row mapping. Returns { entry } on inclusion, or
 * { skip: '<reason>' } when curated out. Pure; deterministic.
 *
 * @param family    closed family vocabulary segment
 * @param reg       the registry config object (url, slug_column, kind, namespace?)
 * @param row       header->cell object from parseCSV
 * @param sourceVersion  the captured HTTP Last-Modified string
 */
export function mapRow(family: string, reg: RegistryConfig, row: Row, sourceVersion: string): MapResult {
  const refColName = pickRefColumn(row);
  const refRaw = refColName ? row[refColName] : '';
  const reference_rfcs = parseRfcRefs(refRaw);

  switch (family) {
    case 'http-status': return mapHttpStatus(reg, row, sourceVersion, reference_rfcs);
    case 'http-method': return mapHttpMethod(reg, row, sourceVersion, reference_rfcs);
    case 'uri-scheme':  return mapUriScheme(reg, row, sourceVersion, reference_rfcs);
    case 'dns-rrtype':  return mapDnsRrtype(reg, row, sourceVersion, reference_rfcs);
    case 'cbor-tag':    return mapCborTag(reg, row, sourceVersion, reference_rfcs);
    case 'port':        return { skip: 'port rows are grouped, not mapped per-row (see groupPorts)' };
    case 'tls-param':   return mapTlsCipher(reg, row, sourceVersion, reference_rfcs);
    default:            return { skip: `no mapper for family '${family}'` };
  }
}

function pickRefColumn(row: Row): string | null {
  // Most registries use 'Reference'; dns uses 'Reference' too. Return the first
  // present so parseRfcRefs has the right cell.
  for (const k of ['Reference', 'reference']) if (k in row) return k;
  return null;
}

// Strip the verbose TEMPORARY-registration parenthetical IANA appends to some
// descriptions, for a clean title; keep the full text in raw_columns + summary
// fallback. Returns the cleaned leading description.
function cleanDesc(s: string): string {
  if (!s) return s;
  return s.replace(/\s*\(TEMPORARY[^)]*\)\s*$/i, '').trim();
}

interface BaseEntryArgs {
  family: string;
  namespace?: string;
  slug: string;
  title: string;
  summary: string;
  kind: string;
  status: string;
  reg: RegistryConfig;
  sourceVersion: string;
  ext: EntryExt;
}

function baseEntry({ family, namespace, slug, title, summary, kind, status, reg, sourceVersion, ext }: BaseEntryArgs): Entry {
  const id = namespace ? `${family}/${namespace}/${slug}` : `${family}/${slug}`;
  const e: Entry = {
    id,
    family,
    ...(namespace ? { namespace } : {}),
    slug,
    title,
    summary,
    kind,
    status,
    verification: 'verified',
    tier: 'A',
    source_url: reg.url,
    source_version: sourceVersion,
    retrieved_date: TODAY,
    ext_type: 'iana-registry-row@1',
    ext,
    updated: TODAY,
  };
  return e;
}

// --- http-status ----------------------------------------------------------
function mapHttpStatus(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const value = (row['Value'] || '').trim();
  const desc = (row['Description'] || '').trim();
  if (!value) return { skip: 'empty Value' };
  if (value.includes('-')) return { skip: `range row ${value}` };
  if (UNASSIGNED_RE.test(desc)) return { skip: `${value} ${desc}` };
  if (!/^\d+$/.test(value)) return { skip: `non-numeric Value '${value}'` };
  const cleanedDesc = cleanDesc(desc);
  const status = 'standard';
  const ext: EntryExt = {
    value: Number(value),
    reference_rfcs: rfcs,
    raw_columns: rawCols(row),
  };
  return {
    entry: baseEntry({
      family: 'http-status', slug: value,
      title: `${value} ${cleanedDesc}`,
      summary: `HTTP status code ${value} ${cleanedDesc}.${rfcs.length ? ` Defined in ${rfcs.join(', ')}.` : ''}`,
      kind: 'status-code', status, reg, sourceVersion: sv, ext,
    }),
  };
}

// --- http-method -----------------------------------------------------------
function mapHttpMethod(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const name = (row['Method Name'] || '').trim();
  if (!name) return { skip: 'empty Method Name' };
  if (UNASSIGNED_RE.test(name)) return { skip: name };
  const sk = slugifyKey(name);
  if (!sk) return { skip: `unslugifiable method '${name}'` };
  const safe = (row['Safe'] || '').trim();
  const idem = (row['Idempotent'] || '').trim();
  const ext: EntryExt = {
    value: name,
    reference_rfcs: rfcs,
    raw_columns: rawCols(row),
  };
  const props: string[] = [];
  if (safe) props.push(`safe: ${safe}`);
  if (idem) props.push(`idempotent: ${idem}`);
  const entry = baseEntry({
    family: 'http-method', slug: sk.slug,
    title: name === '*' ? '* (wildcard, CONNECT/Accept)' : name,
    summary: `HTTP request method ${name}${props.length ? ` (${props.join(', ')})` : ''}.${rfcs.length ? ` Defined in ${rfcs.join(', ')}.` : ''}`,
    kind: 'method', status: 'standard', reg, sourceVersion: sv, ext,
  });
  if (sk.changed) entry.aliases = [name];
  return { entry };
}

// --- uri-scheme ------------------------------------------------------------
function mapUriScheme(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const name = (row['URI Scheme'] || '').trim();
  const status = (row['Status'] || '').trim();
  const desc = (row['Description'] || '').trim();
  if (!name) return { skip: 'empty URI Scheme' };
  if (status !== 'Permanent') return { skip: `${name} status=${status || 'none'}` };
  const sk = slugifyKey(name);
  if (!sk) return { skip: `unslugifiable scheme '${name}'` };
  const ext: EntryExt = {
    value: name,
    reference_rfcs: rfcs,
    raw_columns: rawCols(row),
  };
  const entry = baseEntry({
    family: 'uri-scheme', slug: sk.slug,
    title: `${name}: — ${desc || name}`,
    summary: `URI scheme "${name}:"${desc ? ` — ${desc}` : ''}. IANA status: Permanent.${rfcs.length ? ` Defined in ${rfcs.join(', ')}.` : ''}`,
    kind: 'scheme', status: 'standard', reg, sourceVersion: sv, ext,
  });
  if (sk.changed) entry.aliases = [name];
  return { entry };
}

// --- dns-rrtype ------------------------------------------------------------
function mapDnsRrtype(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const type = (row['TYPE'] || '').trim();
  const value = (row['Value'] || '').trim();
  const meaning = (row['Meaning'] || '').trim();
  if (!type) return { skip: 'empty TYPE' };
  if (UNASSIGNED_RE.test(type)) return { skip: `${value} ${type}` };
  // Some rows are e.g. '*' (ANY/QTYPE) — keep those (they are named mnemonics).
  const sk = slugifyKey(type);
  if (!sk) return { skip: `unslugifiable TYPE '${type}'` };
  const regDate = (row['Registration Date'] || '').trim();
  const ext: EntryExt = {
    value: value ? Number(value) : type,
    reference_rfcs: rfcs,
    ...(regDate ? { registration_date: regDate } : {}),
    raw_columns: rawCols(row),
  };
  const entry = baseEntry({
    family: 'dns-rrtype', slug: sk.slug,
    title: `${type}${meaning ? ` — ${meaning}` : ''}${value ? ` (type ${value})` : ''}`,
    summary: `DNS resource record type ${type}${value ? ` (numeric type ${value})` : ''}${meaning ? `: ${meaning}` : ''}.${rfcs.length ? ` Defined in ${rfcs.join(', ')}.` : ''}`,
    kind: 'rrtype', status: 'standard', reg, sourceVersion: sv, ext,
  });
  // '*' (ANY) is conventionally queried as 'ANY'; surface both.
  const aliases: string[] = [];
  if (sk.changed) aliases.push(type);
  if (type === '*') aliases.push('ANY');
  if (aliases.length) entry.aliases = aliases;
  return { entry };
}

// --- cbor-tag --------------------------------------------------------------
function mapCborTag(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const tag = (row['Tag'] || '').trim();
  const dataItem = (row['Data Item'] || '').trim();
  const semantics = (row['Semantics'] || '').trim();
  if (!tag) return { skip: 'empty Tag' };
  if (tag.includes('-')) return { skip: `range row ${tag}` };
  if (!/^\d+$/.test(tag)) return { skip: `non-numeric Tag '${tag}'` };
  if (UNASSIGNED_RE.test(semantics) || UNASSIGNED_RE.test(dataItem)) return { skip: `${tag} ${semantics || dataItem}` };
  if (!semantics && !dataItem) return { skip: `${tag} empty semantics` };
  const cleaned = cleanDesc(semantics) || semantics;
  const ext: EntryExt = {
    value: Number(tag),
    reference_rfcs: rfcs,
    raw_columns: rawCols(row),
  };
  return {
    entry: baseEntry({
      family: 'cbor-tag', slug: tag,
      title: `CBOR tag ${tag}${cleaned ? ` — ${truncate(cleaned, 60)}` : ''}`,
      summary: `CBOR tag ${tag}${dataItem ? ` (data item: ${dataItem})` : ''}${cleaned ? `: ${cleaned}` : ''}.${rfcs.length ? ` Defined in ${rfcs.join(', ')}.` : ''}`,
      kind: 'tag', status: 'standard', reg, sourceVersion: sv, ext,
    }),
  };
}

// --- tls cipher-suites -----------------------------------------------------
function mapTlsCipher(reg: RegistryConfig, row: Row, sv: string, rfcs: string[]): MapResult {
  const valRaw = (row['Value'] || '').trim();           // e.g. "0x00,0x01"
  const desc = (row['Description'] || '').trim();        // e.g. TLS_RSA_WITH_NULL_MD5
  const recommended = (row['Recommended'] || '').trim(); // Y / N / D
  const dtls = (row['DTLS-OK'] || '').trim();
  if (!valRaw) return { skip: 'empty Value' };
  // Skip reserved/unassigned/grease range markers (Description like 'Unassigned',
  // 'Reserved', or value containing '-').
  if (valRaw.includes('-')) return { skip: `range row ${valRaw}` };
  if (UNASSIGNED_RE.test(desc)) return { skip: `${valRaw} ${desc}` };
  // Build the concatenated hex slug: "0x00,0x01" -> "0x0001".
  const bytes = valRaw.split(',').map((b) => b.trim().replace(/^0x/i, ''));
  if (!bytes.every((b) => /^[0-9a-fA-F]{2}$/.test(b))) return { skip: `non-hex value '${valRaw}'` };
  const slug = '0x' + bytes.join('').toLowerCase();

  // Curation: keep Recommended=='Y' OR a classic suite in the allowlist.
  const isRecommended = recommended.toUpperCase() === 'Y';
  if (!isRecommended && !TLS_CLASSIC_SLUGS.has(slug)) {
    return { skip: `${slug} ${desc} (Recommended=${recommended || 'none'}, not classic)` };
  }

  // status: recommended -> standard; everything else kept is de-facto/legacy.
  const status = isRecommended ? 'standard' : 'de-facto';
  const ext: EntryExt = {
    value: slug,
    reference_rfcs: rfcs,
    recommended: recommended === 'Y' ? true : recommended === 'N' ? false : (recommended || undefined),
    ...(dtls ? { dtls_ok: dtls === 'Y' ? true : dtls === 'N' ? false : dtls } : {}),
    raw_columns: rawCols(row),
  };
  return {
    entry: baseEntry({
      family: 'tls-param', namespace: 'cipher-suites', slug,
      title: `${slug} — ${desc}`,
      summary: `TLS cipher suite ${desc} (${valRaw}, IANA value ${slug}). IANA Recommended: ${recommended || 'unspecified'}.${rfcs.length ? ` Referenced in ${rfcs.join(', ')}.` : ''}`,
      kind: 'parameter', status, reg, sourceVersion: sv, ext,
    }),
  };
}

// --- port (grouped) --------------------------------------------------------
interface PortGroup {
  rows: Row[];
  transports: Set<string>;
  names: Set<string>;
  descs: Set<string>;
}

/**
 * Ports are per-(service, transport) upstream. Collapse to one entry per port
 * NUMBER. Curate: well-known system ports 0-1023 that have a service name on at
 * least one transport. Returns { entries, included, excluded }.
 */
export function groupPorts(reg: RegistryConfig, rows: Row[], sourceVersion: string): {
  entries: Entry[];
  included: string[];
  excluded: Excluded[];
  consideredRows: number;
} {
  const byPort = new Map<number, PortGroup>(); // portNum -> { rows: [], transports:Set, names:Set }
  const excluded: Excluded[] = [];
  let consideredRows = 0;

  for (const row of rows) {
    const portStr = (row['Port Number'] || '').trim();
    if (!portStr || !/^\d+$/.test(portStr)) { continue; } // ranges/blank: not a single port
    const port = Number(portStr);
    if (port < 0 || port > 1023) { continue; } // not well-known; silently outside curation scope
    consideredRows++;
    const name = (row['Service Name'] || '').trim();
    const transport = (row['Transport Protocol'] || '').trim().toLowerCase();
    if (!byPort.has(port)) byPort.set(port, { rows: [], transports: new Set(), names: new Set(), descs: new Set() });
    const g = byPort.get(port)!;
    g.rows.push(row);
    if (transport) g.transports.add(transport);
    if (name) g.names.add(name);
    const d = (row['Description'] || '').trim();
    if (d) g.descs.add(d);
  }

  const entries: Entry[] = [];
  const included: string[] = [];
  for (const [port, g] of [...byPort.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.names.size === 0) {
      excluded.push({ id: `port/${port}`, reason: `no service name on any transport (e.g. Reserved)` });
      continue;
    }
    const primaryName = [...g.names][0];
    const transports = [...g.transports].filter((t) => ['tcp', 'udp', 'sctp', 'dccp'].includes(t));
    const desc = [...g.descs][0] || primaryName;
    // Aggregate references across the grouped rows.
    const rfcSet = new Set<string>();
    for (const r of g.rows) for (const t of parseRfcRefs(r['Reference'] || '')) rfcSet.add(t);
    const rfcs = [...rfcSet];
    // raw_columns: echo the primary (first) row verbatim; note grouping.
    const primaryRow = g.rows[0];
    const ext: EntryExt = {
      value: port,
      reference_rfcs: rfcs,
      transports,
      raw_columns: rawCols(primaryRow),
    };
    const names = [...g.names];
    const entry = baseEntry({
      family: 'port', slug: String(port),
      title: `Port ${port} — ${primaryName}${names.length > 1 ? ` (+${names.length - 1} more)` : ''}`,
      summary: `Well-known port ${port}${transports.length ? ` (${transports.join('/')})` : ''}: ${desc}. Service name${names.length > 1 ? 's' : ''}: ${names.join(', ')}.${rfcs.length ? ` Referenced in ${rfcs.join(', ')}.` : ''}`,
      kind: 'port', status: 'standard',
      reg, sourceVersion, ext,
    });
    if (names.length > 1) entry.aliases = names.slice(1);
    entries.push(entry);
    included.push(entry.id);
  }
  return { entries, included, excluded, consideredRows };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function rawCols(row: Row): Record<string, string> {
  // Verbatim header->cell map, preserving every column in source order.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v == null ? '' : String(v);
  return out;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// 4. parseRegistry — one CSV string -> entries + audit
// ---------------------------------------------------------------------------

/**
 * @param registryId  key in registries.config.json
 * @param reg         the config object
 * @param csvText     raw CSV string
 * @param sourceVersion  captured Last-Modified
 * @returns { entries, included:[ids], excluded:[{id,reason}] }
 */
export function parseRegistry(registryId: string, reg: RegistryConfig, csvText: string, sourceVersion: string): ParseResult {
  const { rows } = parseCSV(csvText);
  const family = reg.family;

  if (family === 'port') {
    const g = groupPorts(reg, rows, sourceVersion);
    return { entries: g.entries, included: g.included, excluded: g.excluded, totalRows: rows.length, consideredRows: g.consideredRows };
  }

  const entries: Entry[] = [];
  const included: string[] = [];
  const excluded: Excluded[] = [];
  for (const row of rows) {
    const res = mapRow(family, reg, row, sourceVersion);
    if (res.entry) { entries.push(res.entry); included.push(res.entry.id); }
    else excluded.push({ row: identifyRow(reg, row), reason: res.skip });
  }
  // Dedupe by id (defensive; registries shouldn't repeat a primary key for the
  // non-port families). Keep first.
  const seen = new Set<string>();
  const deduped: Entry[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) { excluded.push({ row: e.id, reason: 'duplicate id (kept first)' }); continue; }
    seen.add(e.id); deduped.push(e);
  }
  return { entries: deduped, included: [...seen], excluded, totalRows: rows.length };
}

function identifyRow(reg: RegistryConfig, row: Row): string {
  const col = reg.slug_column;
  return (row[col] || '').trim() || JSON.stringify(row).slice(0, 60);
}

// ---------------------------------------------------------------------------
// 5. parseFamily — the cli.ts contract (reads run.ts's cached CSV)
// ---------------------------------------------------------------------------

async function loadConfig(): Promise<RegistryMap> {
  const raw = await readFile(CONFIG_PATH, 'utf8');
  return JSON.parse(raw).registries as RegistryMap;
}

/** Find the registry config whose family (and namespace) match the requested
 *  family string. cli.ts passes a `family` like 'http-status' or 'tls-param'. */
function findRegistryByFamily(registries: RegistryMap, family: string): [string | null, RegistryConfig | null] {
  for (const [id, reg] of Object.entries(registries)) {
    if (reg.family === family) return [id, reg];
  }
  return [null, null];
}

/**
 * cli.ts entry point: re-parse a family deterministically from the CSV that
 * run.ts cached at .cache/tier-a/<registryId>.csv (+ .meta json with the
 * captured Last-Modified). Returns an array of full entry objects.
 *
 * If the cache is absent, throws a clear error telling the operator to run
 * ingest/tier-a/run.ts first (cli.ts should not fetch the network itself).
 */
export async function parseFamily(family: string, _opts: { today?: string } = {}): Promise<Entry[]> {
  const registries = await loadConfig();
  const [registryId, reg] = findRegistryByFamily(registries, family);
  if (!reg || !registryId) throw new Error(`no Tier-A registry configured for family '${family}'`);

  const csvPath = join(CACHE_DIR, `${registryId}.csv`);
  const metaPath = join(CACHE_DIR, `${registryId}.meta.json`);
  if (!existsSync(csvPath)) {
    throw new Error(`no cached CSV at ${csvPath}; run 'bun run ingest/tier-a/run.ts' first to fetch the registry`);
  }
  const csvText = await readFile(csvPath, 'utf8');
  let sourceVersion = `${reg.url} (Last-Modified unknown)`;
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      if (meta.source_version) sourceVersion = meta.source_version;
    } catch { /* fall back to default */ }
  }
  const { entries } = parseRegistry(registryId, reg, csvText, sourceVersion);
  return entries;
}

export default parseFamily;
