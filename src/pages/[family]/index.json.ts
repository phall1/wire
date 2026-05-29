import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

// Per-family manifest: enumerate ids without crawling.
export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection("entries");
  const families = [...new Set(entries.map((e) => e.data.family))];
  return families.map((family) => ({
    params: { family },
    props: {
      items: entries
        .filter((e) => e.data.family === family)
        .map((e) => ({
          id: e.data.id,
          title: e.data.title,
          status: e.data.status,
          verification: e.data.verification,
          kind: e.data.kind,
        })),
    },
  }));
};

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(props.items, null, 2) + "\n", {
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });
