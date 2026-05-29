// prebuild.ts — generate public/_redirects (Cloudflare Pages format) from the
// corpus: alias → canonical, terminal short forms, and bare globally-unique
// slugs. Runs before `astro build`. Bun: `bun run scripts/prebuild.ts`.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA = "data";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".json")) out.push(p);
  }
  return out;
}

interface E { id: string; family: string; slug: string; aliases?: string[] }
const entries: E[] = walk(DATA).map((f) => JSON.parse(readFileSync(f, "utf8")));

// slug → how many families use it (to know what's globally unique)
const slugCount = new Map<string, number>();
for (const e of entries) slugCount.set(e.slug, (slugCount.get(e.slug) ?? 0) + 1);

const redirects = new Map<string, string>(); // from → to (canonical)
const add = (from: string, to: string) => {
  const f = from.startsWith("/") ? from : "/" + from;
  if (f !== "/" + to && !redirects.has(f)) redirects.set(f, "/" + to);
};

for (const e of entries) {
  // bare unique slug:  /418 -> /http-status/418
  if (slugCount.get(e.slug) === 1) add(`/${e.slug}`, e.id);
  // declared aliases
  for (const a of e.aliases ?? []) {
    const slug = a.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (slug) add(`/${slug}`, e.id);
  }
}
// terminal short forms: /osc/133 -> /terminal-osc/133, /csi/sgr, /dec/2004
for (const e of entries) {
  if (e.family === "terminal-osc") add(`/osc/${e.slug}`, e.id);
  if (e.family === "terminal-csi") add(`/csi/${e.slug}`, e.id);
  if (e.family === "terminal-dec-private-mode") add(`/dec/${e.slug}`, e.id);
}

const body =
  [...redirects.entries()].map(([from, to]) => `${from} ${to} 301`).join("\n") + "\n";
mkdirSync("public", { recursive: true });
writeFileSync(join("public", "_redirects"), body);
console.log(`prebuild: wrote public/_redirects (${redirects.size} rules) from ${entries.length} entries`);
