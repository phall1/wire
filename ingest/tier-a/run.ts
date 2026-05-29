#!/usr/bin/env bun
// ingest/tier-a/run.ts — fetch + parse + write the Tier-A IANA corpus.
//
//   bun run ingest/tier-a/run.ts [--family <f>] [--dry-run]
//
// For each registry in ingest/registries.config.json:
//   1. curl -sI URL  -> capture HTTP Last-Modified (source_version)
//   2. curl -sL URL -o <cache>/<id>.csv  -> fetch the CSV (cached so cli.ts and
//      the round-trip gate can re-parse without re-fetching)
//   3. parseRegistry(...)  -> deterministic entries + audit log
//   4. write data/{family}/[{namespace}/]{slug}.json (unless --dry-run)
//
// On a fetch failure: retry once, then LOG and continue with the other
// registries (DESIGN §9 fetch-failure resilience). No LLM is involved.

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { parseRegistry, type RegistryMap, type Entry, type Excluded } from './parse.ts';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data');
// Cache lives OUTSIDE data/ (the build walks data/**/*.json as entries).
const CACHE_DIR = join(REPO_ROOT, '.cache', 'tier-a');
const CONFIG_PATH = join(REPO_ROOT, 'ingest', 'registries.config.json');

interface Args {
  family: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { family: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--family') args.family = argv[++i];
    else if (a.startsWith('--family=')) args.family = a.slice('--family='.length);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function curlHead(url: string): Promise<string | null> {
  // -sI = silent HEAD; -L follow redirects. Returns the Last-Modified value or null.
  const { stdout } = await execFileP('curl', ['-sIL', url], { maxBuffer: 1 << 20 });
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^last-modified:\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

async function curlDownload(url: string, outPath: string): Promise<void> {
  await execFileP('curl', ['-sL', '--fail', url, '-o', outPath], { maxBuffer: 1 << 20 });
}

async function fetchWithRetry(url: string, outPath: string): Promise<{ lastMod: string | null }> {
  // capture Last-Modified, then download. One retry on failure.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const lastMod = await curlHead(url).catch(() => null);
      await curlDownload(url, outPath);
      if (!existsSync(outPath)) throw new Error('curl produced no output file');
      return { lastMod };
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new Error('fetchWithRetry: exhausted attempts');
}

async function clearFamilyDir(family: string, namespace?: string): Promise<void> {
  // Remove existing generated entries for a clean rewrite (Tier-A is fully
  // regenerable). Only removes .json files in the target dir.
  const dir = namespace ? join(DATA_DIR, family, namespace) : join(DATA_DIR, family);
  if (!existsSync(dir)) return;
  for (const name of await readdir(dir)) {
    if (name.endsWith('.json')) await rm(join(dir, name));
  }
}

async function writeEntry(entry: Entry): Promise<void> {
  const rel = entry.namespace
    ? join(entry.family, entry.namespace, `${entry.slug}.json`)
    : join(entry.family, `${entry.slug}.json`);
  const full = join(DATA_DIR, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(entry, null, 2) + '\n', 'utf8');
}

interface SummaryRow {
  registryId: string;
  family: string;
  namespace: string | null;
  totalRows: number;
  consideredRows?: number;
  included: number;
  excluded: Excluded[];
  lastMod: string | null;
}

interface FetchFailure {
  registryId: string;
  url: string;
  error: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registries: RegistryMap = JSON.parse(await readFile(CONFIG_PATH, 'utf8')).registries;
  await mkdir(CACHE_DIR, { recursive: true });

  const summary: SummaryRow[] = [];
  const fetchFailures: FetchFailure[] = [];

  for (const [registryId, reg] of Object.entries(registries)) {
    if (args.family && reg.family !== args.family) continue;
    const csvPath = join(CACHE_DIR, `${registryId}.csv`);
    const metaPath = join(CACHE_DIR, `${registryId}.meta.json`);

    let lastMod: string | null = null;
    try {
      ({ lastMod } = await fetchWithRetry(reg.url, csvPath));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tier-a] FETCH FAILED (after retry): ${registryId} <- ${reg.url}: ${message}`);
      fetchFailures.push({ registryId, url: reg.url, error: message });
      continue;
    }

    const sourceVersion = lastMod
      ? `IANA registry, Last-Modified: ${lastMod}`
      : `${reg.url} (Last-Modified unavailable)`;
    await writeFile(metaPath, JSON.stringify({ url: reg.url, source_version: sourceVersion, retrieved_date: '2026-05-29' }, null, 2) + '\n', 'utf8');

    const csvText = await readFile(csvPath, 'utf8');
    const { entries, included, excluded, totalRows, consideredRows } = parseRegistry(registryId, reg, csvText, sourceVersion);

    if (!args.dryRun) {
      await clearFamilyDir(reg.family, reg.namespace);
      for (const e of entries) await writeEntry(e);
    }

    summary.push({ registryId, family: reg.family, namespace: reg.namespace || null, totalRows, consideredRows, included: included.length, excluded, lastMod });
  }

  // ---- Report ----
  console.log('\n================ Tier-A ingest report ================');
  console.log(args.dryRun ? '(DRY RUN — no files written)\n' : '(live — wrote data/{family}/...)\n');
  let grand = 0;
  for (const s of summary) {
    grand += s.included;
    const fam = s.namespace ? `${s.family}/${s.namespace}` : s.family;
    console.log(`# ${s.registryId}  ->  ${fam}`);
    console.log(`   Last-Modified : ${s.lastMod || 'unavailable'}`);
    console.log(`   rows in CSV   : ${s.totalRows}${s.consideredRows != null ? ` (in curation scope: ${s.consideredRows})` : ''}`);
    console.log(`   WRITTEN       : ${s.included}`);
    console.log(`   excluded      : ${s.excluded.length}`);
    // Summarize exclusion reasons (collapse identical reason prefixes).
    const reasonCounts = new Map<string, number>();
    for (const x of s.excluded) {
      const key = bucketReason(x.reason);
      reasonCounts.set(key, (reasonCounts.get(key) || 0) + 1);
    }
    for (const [reason, count] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`       - ${count.toString().padStart(5)}  ${reason}`);
    }
    console.log('');
  }
  console.log(`TOTAL Tier-A entries written: ${grand}`);
  if (fetchFailures.length) {
    console.log(`\nFETCH FAILURES (${fetchFailures.length}):`);
    for (const f of fetchFailures) console.log(`   - ${f.registryId}: ${f.error}`);
  }
  console.log('======================================================\n');

  // Emit a machine-readable audit alongside the cache.
  await writeFile(join(CACHE_DIR, 'last-run.json'), JSON.stringify({
    retrieved_date: '2026-05-29',
    dry_run: args.dryRun,
    total_written: grand,
    registries: summary.map((s) => ({
      registryId: s.registryId, family: s.family, namespace: s.namespace,
      totalRows: s.totalRows, consideredRows: s.consideredRows,
      written: s.included, excluded: s.excluded.length,
      last_modified: s.lastMod,
    })),
    fetch_failures: fetchFailures,
  }, null, 2) + '\n', 'utf8');
}

function bucketReason(reason: string): string {
  if (!reason) return '(unspecified)';
  if (/^range row/.test(reason)) return 'range row (e.g. 105-199)';
  if (/Unassigned/i.test(reason)) return 'Unassigned';
  if (/Reserved/i.test(reason)) return 'Reserved';
  if (/Private use/i.test(reason)) return 'Private use';
  if (/status=/.test(reason)) return 'uri-scheme status != Permanent (Provisional/Historical)';
  if (/Recommended=/.test(reason)) return 'tls suite: not Recommended=Y and not classic';
  if (/no service name/.test(reason)) return 'port: no service name (nameless/Reserved)';
  if (/non-numeric/.test(reason)) return 'non-numeric primary key';
  if (/non-hex/.test(reason)) return 'tls: non-hex value';
  if (/empty/.test(reason)) return 'empty/blank primary cell';
  if (/duplicate/.test(reason)) return 'duplicate id';
  return reason;
}

main().catch((err) => {
  console.error('ingest/tier-a/run.ts crashed:', err.stack || err);
  process.exit(1);
});
