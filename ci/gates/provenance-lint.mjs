// provenance-lint.mjs — GATE 2: provenance lint.
//
// Provenance is mandatory and inline (DESIGN §4). This gate asserts:
//   - source_url, source_version, retrieved_date are present and non-empty.
//   - source_url is a parseable absolute URL.
//   - retrieved_date is an ISO date (YYYY-MM-DD).
//   - tier 'C' OR an entry that fuses >1 distinct source requires attribution[]
//     with at least one row.
//   - every attribution row carries a non-empty source_url + source_version.
//
// "More than one distinct source" = more than one distinct source_url host
// across core.source_url + every attribution[].source_url.

import { hostOf } from './lib.mjs';

export const name = 'provenance-lint';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function run(entries) {
  const failures = [];

  for (const { id, path, entry, loadError } of entries) {
    if (loadError) continue; // schema gate owns parse failures

    const add = (message) => failures.push({ id, path, message });

    for (const field of ['source_url', 'source_version', 'retrieved_date']) {
      const v = entry[field];
      if (typeof v !== 'string' || v.trim() === '') add(`provenance field '${field}' missing or empty`);
    }

    if (typeof entry.source_url === 'string' && hostOf(entry.source_url) === null) {
      add(`source_url is not a parseable absolute URL: ${JSON.stringify(entry.source_url)}`);
    }
    if (typeof entry.retrieved_date === 'string' && !ISO_DATE.test(entry.retrieved_date)) {
      add(`retrieved_date is not an ISO date (YYYY-MM-DD): ${JSON.stringify(entry.retrieved_date)}`);
    }

    const attribution = Array.isArray(entry.attribution) ? entry.attribution : [];

    // distinct sources across core + attribution
    const hosts = new Set();
    if (typeof entry.source_url === 'string') {
      const h = hostOf(entry.source_url);
      if (h) hosts.add(h);
    }
    for (const row of attribution) {
      if (row && typeof row.source_url === 'string') {
        const h = hostOf(row.source_url);
        if (h) hosts.add(h);
      }
    }
    const multiSource = hosts.size > 1;
    const needsAttribution = entry.tier === 'C' || multiSource;

    if (needsAttribution && attribution.length < 1) {
      const why = entry.tier === 'C' ? "tier 'C'" : 'multi-source entry';
      add(`${why} requires attribution[] with at least 1 row`);
    }

    attribution.forEach((row, i) => {
      if (!row || typeof row !== 'object') {
        add(`attribution[${i}] is not an object`);
        return;
      }
      for (const field of ['source_url', 'source_version']) {
        const v = row[field];
        if (typeof v !== 'string' || v.trim() === '') add(`attribution[${i}].${field} missing or empty`);
      }
      if (typeof row.source_url === 'string' && row.source_url.trim() !== '' && hostOf(row.source_url) === null) {
        add(`attribution[${i}].source_url is not a parseable absolute URL`);
      }
    });
  }

  return { name, failures, notes: [] };
}
