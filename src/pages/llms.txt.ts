import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { FAMILIES, SITE } from "../lib/wire";

export const GET: APIRoute = async () => {
  const entries = await getCollection("entries");
  const families = [...new Set(entries.map((e) => e.data.family))].sort();
  const total = entries.length;
  const lines: string[] = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.tagline}`,
    "",
    `${SITE.name} is a single, searchable, curlable reference for computer / network / API / terminal protocols and standards — served for both humans (a fast terminal-styled static page) and AI agents (the same fact as structured JSON at a stable URL). ${total} entries across ${families.length} families. Canonical id == permalink path: \`{family}[/{namespace}]/{slug}\` (e.g. \`terminal-osc/133\`).`,
    "",
    "## Agent contract",
    "",
    "- Get JSON: send `Accept: application/json` on a bare path, OR append `.json`.",
    "- Sub-facts are `#fragments` (e.g. `terminal-osc/133#D`); the parent JSON already holds them.",
    "- Under-specified guesses 301-redirect to the canonical id.",
    "- Enumerate per-family manifests below and fetch entries by constructed id; don't scrape HTML.",
    "- Root manifest: /index.json",
    "- Search index (id, title, summary, family, kind): /search-index.json",
    "- Full corpus dump: /llms-full.txt",
    "",
    "## Families",
    "",
    ...families.map((f) => {
      const n = entries.filter((e) => e.data.family === f).length;
      return `- [${f}](/${f}/index.json): ${FAMILIES[f]?.blurb ?? f} (${n} entries)`;
    }),
    "",
    "## Manifests",
    "",
    "- [Root manifest](/index.json): every entry's id, title, family, kind, verification.",
    "- [Search index](/search-index.json): ranked-search fields for all entries.",
    ...families.map((f) => `- [${f} manifest](/${f}/index.json): ${FAMILIES[f]?.blurb ?? f}.`),
    "",
    "## Optional",
    "",
    "- [Full corpus dump](/llms-full.txt): one-line-per-entry index for one-shot context loading.",
    "- [Agent runtime design](/stack.md): source-backed proposal for isolation, durable execution, bounded authority, external-effect reconciliation, and acceptance tests; not an implemented runtime.",
    "- [Hardware sketch](/substrate): exploratory proposal with unresolved encoding and hardware questions.",
    "- [MCP server](https://github.com/phall1/wire/tree/main/mcp): stateless Model Context Protocol shim exposing search/get/list_families/get_family.",
    "- [Source repository](https://github.com/phall1/wire): data, gates, and ingest code.",
    "- [Design](https://github.com/phall1/wire/blob/main/DESIGN.md): source-of-truth tiers, licensing stance, permalink scheme, schema, integrity gates.",
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
};
