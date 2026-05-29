import type { APIRoute, GetStaticPaths } from "astro";
import { getCollection } from "astro:content";

// The canonical agent representation: /{family}[/{namespace}]/{slug}.json
export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await getCollection("entries");
  return entries.map((e) => ({ params: { id: e.data.id }, props: { data: e.data } }));
};

export const GET: APIRoute = ({ props }) =>
  new Response(JSON.stringify(props.data, null, 2) + "\n", {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
