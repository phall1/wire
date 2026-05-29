// quorum-lint.mjs — GATE 5: cross-source quorum.
//
// Tier 'C' entries are LLM/human synthesis across multiple sources and must
// satisfy quorum (DESIGN §5.5): at least 2 DISTINCT source_url hosts across
// core.source_url + every attribution[].source_url. If fewer than 2 distinct
// hosts, the entry has NOT met quorum and therefore must NOT claim it is
// 'verified' — its verification must be 'unverified' or 'contested'. Claiming
// 'verified' below quorum is a failure.
//
// (Two sources on the same host are not independent; we count by host, matching
// the provenance-lint multi-source rule.)

import { hostOf } from './lib.mjs';

export const name = 'quorum-lint';

export async function run(entries) {
  const failures = [];

  for (const { id, path, entry, loadError } of entries) {
    if (loadError) continue;
    if (entry.tier !== 'C') continue;

    const hosts = new Set();
    const h0 = hostOf(entry.source_url);
    if (h0) hosts.add(h0);
    for (const row of Array.isArray(entry.attribution) ? entry.attribution : []) {
      if (row && typeof row.source_url === 'string') {
        const h = hostOf(row.source_url);
        if (h) hosts.add(h);
      }
    }

    if (hosts.size < 2 && entry.verification === 'verified') {
      failures.push({
        id,
        path,
        message: `tier 'C' entry has only ${hosts.size} distinct source host(s) [${[...hosts].join(', ') || 'none'}] — quorum (>=2) not met, so verification must be 'unverified' or 'contested', not 'verified'`,
      });
    }
  }

  return { name, failures, notes: [] };
}
