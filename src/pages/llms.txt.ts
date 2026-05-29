import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { FAMILIES, SITE } from "../lib/wire";

export const GET: APIRoute = async () => {
  const entries = await getCollection("entries");
  const families = [...new Set(entries.map((e) => e.data.family))].sort();
  const lines: string[] = [
    `# ${SITE.name}`,
    "",
    `> ${SITE.tagline}`,
    "",
    "## Agent contract",
    "",
    "- Canonical id == permalink path: `{family}[/{namespace}]/{slug}` (e.g. `terminal-osc/133`).",
    "- Get JSON: send `Accept: application/json` on a bare path, OR append `.json`.",
    "- Sub-facts are `#fragments` (e.g. `terminal-osc/133#D`); the parent JSON already holds them.",
    "- Under-specified guesses 301-redirect to the canonical id.",
    "- Enumerate per-family manifests below and fetch entries by constructed id; don't scrape HTML.",
    "- Root manifest: /index.json",
    "",
    "## Families",
    "",
    ...families.map(
      (f) =>
        `- [${f}](/${f}/index.json) — ${FAMILIES[f]?.blurb ?? f} (${entries.filter((e) => e.data.family === f).length})`,
    ),
    "",
  ];
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
};
