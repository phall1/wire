import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { FAMILIES, SITE } from "../lib/wire";

// Root manifest: family vocabulary + counts + manifest links.
export const GET: APIRoute = async () => {
  const entries = await getCollection("entries");
  const families = [...new Set(entries.map((e) => e.data.family))].sort();
  const body = {
    name: SITE.name,
    domain: SITE.domain,
    tagline: SITE.tagline,
    total: entries.length,
    families: families.map((f) => ({
      family: f,
      blurb: FAMILIES[f]?.blurb ?? f,
      count: entries.filter((e) => e.data.family === f).length,
      manifest: `/${f}/index.json`,
    })),
  };
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
};
