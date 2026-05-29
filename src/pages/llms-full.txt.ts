import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { SITE } from "../lib/wire";

// Fully-inlined corpus dump for one-shot agent context loading.
export const GET: APIRoute = async () => {
  const entries = (await getCollection("entries")).sort((a, b) => a.data.id.localeCompare(b.data.id));
  const lines: string[] = [`# ${SITE.name} — full corpus`, "", `> ${SITE.tagline}`, ""];
  for (const e of entries) {
    lines.push(`## ${e.data.id}`, `${e.data.title} — ${e.data.summary}`, `json: /${e.data.id}.json`, "");
  }
  return new Response(lines.join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" },
  });
};
