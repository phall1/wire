// tier-a-roundtrip.mjs — GATE 3: tier-A round-trip (lightweight).
//
// The FULL re-fetch + re-parse + diff against upstream IANA is the NIGHTLY job
// (ingest/cli.mjs, .github/workflows/ingest.yml) — NOT this gate. A CI gate must
// be offline and deterministic, so here we only assert the *shape* that makes a
// tier-A entry round-trippable later:
//
//   - ext_type is 'iana-registry-row@1' (tier A is a deterministic IANA parse).
//   - ext.iana-registry-row.raw_columns exists and is non-empty (the verbatim
//     parsed row the nightly diff compares against).
//   - source_url points at an iana.org host (the machine-readable upstream).
//
// No tier-A entries exist yet (the seed is tier C); this gate is then a no-op
// that simply reports 0 tier-A entries.
//
// SCOPE: this gate polices the IANA-round-trippable shape only. Encoding entries
// (ext_type 'encoding@1') are also a deterministic, no-LLM class and carry
// tier 'A' (the core schema's tier enum has no separate 'enc' value, see
// DESIGN §2), but they are proven by the encoding-exec gate's test-vector
// EXECUTION, not by an IANA re-fetch. They are therefore excluded here.

import { hostOf } from './lib.mjs';

export const name = 'tier-a-roundtrip';

export async function run(entries) {
  const failures = [];
  let tierA = 0;

  for (const { id, path, entry, loadError } of entries) {
    if (loadError) continue;
    if (entry.tier !== 'A') continue;
    // Encodings are deterministic but not IANA rows; the encoding-exec gate
    // proves them. Skip them here so the IANA-shape checks don't misfire.
    if (entry.ext_type === 'encoding@1') continue;
    tierA += 1;
    const add = (message) => failures.push({ id, path, message });

    if (entry.ext_type !== 'iana-registry-row@1') {
      add(`tier 'A' entry must declare ext_type 'iana-registry-row@1', got '${entry.ext_type}'`);
    }

    const ext = entry.ext ?? {};
    // accept either ext.iana-registry-row.raw_columns or a flat ext.raw_columns,
    // tolerating the not-yet-frozen iana-registry-row@1 shape.
    const block = ext['iana-registry-row'] ?? ext;
    const cols = block?.raw_columns;
    const present =
      (Array.isArray(cols) && cols.length > 0) ||
      (cols && typeof cols === 'object' && Object.keys(cols).length > 0);
    if (!present) {
      add(`tier 'A' entry must carry non-empty ext.iana-registry-row.raw_columns`);
    }

    const host = hostOf(entry.source_url);
    if (!host || !(host === 'iana.org' || host === 'www.iana.org' || host.endsWith('.iana.org'))) {
      add(`tier 'A' entry source_url must be on iana.org, got host '${host ?? '<unparseable>'}'`);
    }
  }

  return { name, failures, notes: [`${tierA} tier-A entr${tierA === 1 ? 'y' : 'ies'} checked (full re-fetch deferred to nightly ingest)`] };
}
