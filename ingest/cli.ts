#!/usr/bin/env bun
// ingest/cli.ts — the update-agent CLI (minimal, real).
//
//   bun run ingest/cli.ts --family <f> [--dry-run] [--json]
//
// For a TIER-A family it re-runs the DETERMINISTIC parser, diffs the freshly
// parsed entries against what is stored under data/{family}/, and prints a
// reviewable, unified-ish change report. It NEVER writes when --dry-run is set;
// even without --dry-run this CLI only writes to data/ and emits a report — it
// cannot merge, cannot deploy, cannot bypass the gates (DESIGN §6).
//
// The deterministic parsers live under ingest/tier-a/ (owned by the content
// agent). This CLI imports ingest/tier-a/parse.ts and DEGRADES GRACEFULLY if it
// is not there yet: it reports that the parser is unavailable and exits 0 in
// --dry-run (nothing to do) or a clear nonzero otherwise, never inventing data.
//
// Tier B/C families are human/LLM-gated and are intentionally NOT auto-ingested
// here; this CLI handles only the self-healing Tier-A path. The nightly workflow
// (.github/workflows/ingest.yml) runs this and opens a PR on drift.

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { Entry } from './tier-a/parse.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DATA_DIR = join(REPO_ROOT, 'data');
const TODAY = '2026-05-29'; // pinned literal; never compute at runtime.

interface Args {
  family: string | null;
  dryRun: boolean;
  json: boolean;
  help?: boolean;
}

type ParseFamily = (family: string, opts?: { today?: string }) => Promise<Entry[]>;

/** A stored entry plus the file it was loaded from. */
interface StoredEntry {
  entry: Entry;
  file: string;
}

/** A flat per-leaf diff using dotted JSON paths. */
interface FieldDiff {
  path: string;
  old: unknown;
  new: unknown;
}

/** A per-id change record. */
interface Change {
  id: string;
  kind: 'added' | 'removed' | 'modified' | 'unchanged';
  fields: FieldDiff[];
  parsed?: Entry;
  file?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { family: null, dryRun: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--family') args.family = argv[++i];
    else if (a.startsWith('--family=')) args.family = a.slice('--family='.length);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const USAGE = `usage: bun run ingest/cli.ts --family <f> [--dry-run] [--json]

Re-runs the deterministic Tier-A parser for <f>, diffs against data/<f>/, and
emits a reviewable change report. --dry-run never writes (default for CI poll).`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (!args.family) {
    console.error('error: --family is required\n\n' + USAGE);
    process.exit(2);
  }

  // Load the Tier-A parser, degrading gracefully if absent.
  const parserPath = join(__dirname, 'tier-a', 'parse.ts');
  let parseFamily: ParseFamily | null = null;
  if (existsSync(parserPath)) {
    try {
      const mod = await import(parserPath);
      parseFamily = mod.parseFamily ?? mod.default ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reportFatal(args, `failed to import ingest/tier-a/parse.ts: ${message}`);
      return;
    }
  }
  if (typeof parseFamily !== 'function') {
    const msg = `Tier-A parser not available yet (expected ingest/tier-a/parse.ts exporting parseFamily). Nothing to ingest for '${args.family}'.`;
    if (args.json) console.log(JSON.stringify({ family: args.family, ok: true, parser_available: false, message: msg, changes: [] }, null, 2));
    else console.log(msg);
    // Not an error in --dry-run (nothing to do). Nonzero otherwise so a real run
    // surfaces the missing parser rather than silently succeeding.
    process.exit(args.dryRun ? 0 : 3);
  }

  // Re-parse upstream deterministically. The parser owns fetching/parsing and
  // returns an array of full core+ext entry objects keyed by id.
  let parsed: Entry[];
  try {
    parsed = await parseFamily(args.family, { today: TODAY });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportFatal(args, `parser failed for family '${args.family}': ${message}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    reportFatal(args, `parser for '${args.family}' did not return an array of entries`);
    return;
  }

  // Load currently stored entries for the family.
  const stored = await loadStored(args.family);

  // Diff.
  const changes = diffEntries(stored, parsed);
  const hasDrift = changes.some((c) => c.kind !== 'unchanged');

  // Emit report. Strip the internal `parsed`/`file` carriers from the public report.
  if (args.json) {
    console.log(JSON.stringify({
      family: args.family,
      ok: true,
      parser_available: true,
      dry_run: args.dryRun,
      drift: hasDrift,
      retrieved_date: TODAY,
      changes: changes.map(({ parsed, file, ...rest }) => rest),
    }, null, 2));
  } else {
    printTextReport(args.family, changes, args.dryRun);
  }

  // Write only when NOT dry-run and there is drift.
  if (hasDrift && !args.dryRun) {
    await applyChanges(args.family, changes);
    if (!args.json) console.log(`\nwrote ${changes.filter((c) => c.kind !== 'unchanged').length} change(s) to data/${args.family}/`);
  }

  // Exit code: 0 = no drift; 1 = drift detected (so the nightly job knows to open
  // a PR / a manual run knows there is something to review).
  process.exit(hasDrift ? 1 : 0);
}

function reportFatal(args: Args, message: string): void {
  if (args.json) console.log(JSON.stringify({ family: args.family, ok: false, error: message }, null, 2));
  else console.error(`error: ${message}`);
  process.exit(2);
}

async function loadStored(family: string): Promise<Map<string, StoredEntry>> {
  const dir = join(DATA_DIR, family);
  const map = new Map<string, StoredEntry>();
  if (!existsSync(dir)) return map;
  // Walk recursively so namespaced families (e.g. tls-param/cipher-suites/...)
  // are picked up, not just the top-level family dir.
  async function walk(d: string): Promise<void> {
    const ents = await readdir(d, { withFileTypes: true });
    for (const ent of ents) {
      const full = join(d, ent.name);
      if (ent.isDirectory()) { await walk(full); continue; }
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      const raw = await readFile(full, 'utf8');
      const entry = JSON.parse(raw) as Entry;
      map.set(entry.id, { entry, file: full });
    }
  }
  await walk(dir);
  return map;
}

/**
 * Diff stored vs freshly parsed entries. Returns one record per id:
 *   { id, kind: 'added'|'removed'|'modified'|'unchanged', fields: [{path, old, new}] }
 * 'fields' is populated for 'modified' (a per-field old->new list).
 */
function diffEntries(stored: Map<string, StoredEntry>, parsed: Entry[]): Change[] {
  const out: Change[] = [];
  const parsedById = new Map<string, Entry>(parsed.map((e) => [e.id, e]));

  for (const [id, p] of parsedById) {
    const s = stored.get(id);
    if (!s) { out.push({ id, kind: 'added', fields: fieldDiff({}, p), parsed: p }); continue; }
    const fields = fieldDiff(s.entry, p);
    // ignore pure retrieved_date / updated churn when nothing else changed
    const substantive = fields.filter((f) => f.path !== 'retrieved_date' && f.path !== 'updated');
    out.push({ id, kind: substantive.length ? 'modified' : 'unchanged', fields, parsed: p });
  }
  for (const [id, s] of stored) {
    if (!parsedById.has(id)) out.push({ id, kind: 'removed', fields: fieldDiff(s.entry, {}), file: s.file });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Flat per-leaf old->new diff using dotted JSON paths. */
function fieldDiff(oldObj: unknown, newObj: unknown): FieldDiff[] {
  const oldFlat = flatten(oldObj);
  const newFlat = flatten(newObj);
  const keys = new Set([...Object.keys(oldFlat), ...Object.keys(newFlat)]);
  const diffs: FieldDiff[] = [];
  for (const k of [...keys].sort()) {
    const a = oldFlat[k], b = newFlat[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ path: k, old: a ?? null, new: b ?? null });
  }
  return diffs;
}

function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object') { out[prefix || '.'] = obj; return out; }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    if (obj.length === 0) out[prefix] = [];
    return out;
  }
  const keys = Object.keys(obj as Record<string, unknown>);
  if (keys.length === 0) out[prefix] = {};
  for (const k of keys) flatten((obj as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function printTextReport(family: string, changes: Change[], dryRun: boolean): void {
  const drift = changes.filter((c) => c.kind !== 'unchanged');
  console.log(`tier-A ingest report: family '${family}'  (${dryRun ? 'DRY RUN — no writes' : 'live'})`);
  console.log('='.repeat(64));
  if (drift.length === 0) { console.log('no drift: stored data matches freshly parsed upstream.'); return; }
  for (const c of drift) {
    console.log(`${markFor(c.kind)} ${c.id}  (${c.kind})`);
    for (const f of c.fields) {
      const oldS = f.old === null || f.old === undefined ? '∅' : JSON.stringify(f.old);
      const newS = f.new === null || f.new === undefined ? '∅' : JSON.stringify(f.new);
      console.log(`    ${f.path}`);
      console.log(`      - ${oldS}`);
      console.log(`      + ${newS}`);
    }
  }
  console.log('='.repeat(64));
  console.log(`${drift.length} entr${drift.length === 1 ? 'y' : 'ies'} with drift.`);
}

function markFor(kind: Change['kind']): string {
  return kind === 'added' ? '[+]' : kind === 'removed' ? '[-]' : '[~]';
}

async function applyChanges(family: string, changes: Change[]): Promise<void> {
  const dir = join(DATA_DIR, family);
  await mkdir(dir, { recursive: true });
  // Writes added/modified entries from the parser output. Does NOT delete files
  // on 'removed': a vanished upstream row is a semantic event for human review,
  // not a silent delete — the report flags it and the PR reviewer decides.
  // (Nightly CI runs with --dry-run + opens a PR, so this write path is reserved
  // for an explicit local non-dry-run reconcile.)
  for (const c of changes) {
    if ((c.kind === 'added' || c.kind === 'modified') && c.parsed) {
      const slug = c.parsed.slug ?? c.id.split('/').pop();
      const file = join(dir, `${slug}.json`);
      await writeFile(file, JSON.stringify(c.parsed, null, 2) + '\n', 'utf8');
    }
  }
}

main().catch((err) => {
  console.error('ingest/cli.ts crashed:', err);
  process.exit(2);
});
