#!/usr/bin/env node
// run-all.mjs — orchestrates the 5 DATA-INTEGRITY gates over the whole corpus.
//
//   node ci/gates/run-all.mjs            human + machine-readable summary
//   node ci/gates/run-all.mjs --json     machine-readable JSON only (to stdout)
//
// Loads every data/**/*.json once, runs each gate, prints per-entry failures
// with the entry id, prints a machine-readable summary, and exits NONZERO if any
// gate has a failure (so npm run gates fails the deploy job). These gates check
// DATA INTEGRITY ONLY: well-formed, cited, internally correct. They are not a
// conformance harness — the single code-executing gate (encoding-exec) runs only
// declared codec test-vectors, not any real protocol implementation.

import { loadEntries, ajvAvailable, toJSON } from './lib.mjs';
import * as schema from './schema.mjs';
import * as provenance from './provenance-lint.mjs';
import * as tierA from './tier-a-roundtrip.mjs';
import * as encoding from './encoding-exec.mjs';
import * as quorum from './quorum-lint.mjs';

const GATES = [schema, provenance, tierA, encoding, quorum];

async function main() {
  const jsonOnly = process.argv.includes('--json');
  const entries = await loadEntries();
  const validator = (await ajvAvailable()) ? 'ajv' : 'structural-fallback';

  const results = [];
  for (const gate of GATES) {
    const res = await gate.run(entries);
    results.push({ name: res.name, failures: res.failures ?? [], notes: res.notes ?? [] });
  }

  const totalFailures = results.reduce((n, r) => n + r.failures.length, 0);
  const ok = totalFailures === 0;

  const summary = {
    ok,
    validator,
    entries_checked: entries.length,
    total_failures: totalFailures,
    gates: results.map((r) => ({
      name: r.name,
      ok: r.failures.length === 0,
      failures: r.failures.length,
      details: r.failures,
      notes: r.notes,
    })),
  };

  if (jsonOnly) {
    process.stdout.write(toJSON(summary) + '\n');
    process.exit(ok ? 0 : 1);
  }

  // Human-readable section.
  console.log(`protocols data-integrity gates  (validator: ${validator}, entries: ${entries.length})`);
  console.log('='.repeat(64));
  for (const r of results) {
    const mark = r.failures.length === 0 ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.name}  (${r.failures.length} failure(s))`);
    for (const f of r.failures) console.log(`        - ${f.id}: ${f.message}  (${f.path})`);
    for (const n of r.notes) console.log(`        note: ${n}`);
  }
  console.log('='.repeat(64));

  // Machine-readable summary (one line, JSON), greppable by CI / agents.
  console.log('SUMMARY ' + JSON.stringify({
    ok,
    validator,
    entries_checked: summary.entries_checked,
    total_failures: totalFailures,
    gates: summary.gates.map((g) => ({ name: g.name, ok: g.ok, failures: g.failures })),
  }));

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('run-all.mjs crashed:', err);
  process.exit(2);
});
