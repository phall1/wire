import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { FAMILIES, SITE } from "../lib/wire";

// Fully-inlined corpus index for one-shot agent context loading.
// Grouped by family; each entry is a single file-list line with id, title,
// summary and a link to its canonical JSON.
export const GET: APIRoute = async () => {
  const entries = (await getCollection("entries")).sort((a, b) => a.data.id.localeCompare(b.data.id));
  const families = [...new Set(entries.map((e) => e.data.family))].sort();
  const lines: string[] = [
    `# ${SITE.name} — full corpus`,
    "",
    `> ${SITE.tagline}`,
    "",
    `${entries.length} entries across ${families.length} families. Each line: \`id\` — title — summary — link to canonical JSON. Sub-facts are \`#fragments\` on the parent entry.`,
    "",
  ];
  for (const f of families) {
    lines.push(`## ${f}`, "", `> ${FAMILIES[f]?.blurb ?? f}`, "");
    for (const e of entries.filter((x) => x.data.family === f)) {
      lines.push(`- [${e.data.id}](/${e.data.id}.json): ${e.data.title} — ${e.data.summary}`);
    }
    lines.push("");
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
};