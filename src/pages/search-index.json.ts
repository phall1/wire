import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

// Verified entries only (trust beats breadth). Humans only; agents enumerate
// manifests instead.
export const GET: APIRoute = async () => {
  const entries = await getCollection("entries");
  const index = entries
    .filter((e) => e.data.verification !== "unverified")
    .map((e) => ({
      id: e.data.id,
      title: e.data.title,
      summary: e.data.summary,
      aliases: e.data.aliases ?? [],
      family: e.data.family,
      kind: e.data.kind,
    }));
  return new Response(JSON.stringify(index), {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
};
