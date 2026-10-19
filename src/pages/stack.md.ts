import type { APIRoute } from "astro";
import source from "./stack.md?raw";

// Serve the same source as the HTML page, without Astro frontmatter.
export const GET: APIRoute = () => new Response(
  source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ""),
  { headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" } },
);
