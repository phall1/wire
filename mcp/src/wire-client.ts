// wire-client.ts — a thin, stateless shim over wire's live static JSON.
//
// Every method here is a single `fetch` against the identical files the human
// site and the curl interface serve, so the MCP surface can never drift from
// the published corpus. There is no local copy of the data, no database, and no
// per-request state: this Worker is a pure function of wire.phall.io.

/** Default origin; overridable via the WIRE_ORIGIN var so `wrangler dev` can
 *  point at a local `astro preview` if desired. */
export const DEFAULT_ORIGIN = "https://wire.phall.io";

/** Root manifest shape (GET /index.json). */
export interface RootManifest {
  name: string;
  domain: string;
  tagline: string;
  total: number;
  families: { family: string; blurb: string; count: number; manifest: string }[];
}

/** Per-family manifest row (GET /{family}/index.json). */
export interface FamilyRow {
  id: string;
  title: string;
  status: string;
  verification: string;
  kind: string;
}

/** Search-index row (GET /search-index.json) — verified entries only. */
export interface SearchRow {
  id: string;
  title: string;
  summary: string;
  aliases: string[];
  family: string;
  kind: string;
}

/** A ranked search hit returned by the `search` tool. */
export interface SearchHit {
  id: string;
  title: string;
  summary: string;
  family: string;
  kind: string;
  score: number;
}

export class WireClient {
  constructor(private readonly origin: string = DEFAULT_ORIGIN) {
    // Normalize away any trailing slash so URL joins are predictable.
    this.origin = origin.replace(/\/+$/, "");
  }

  private async getJSON<T>(path: string): Promise<T> {
    const url = `${this.origin}${path}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "wire-mcp" },
      // Lean on Cloudflare's edge cache: the corpus only changes on redeploy,
      // so a short TTL keeps the shim fast without ever serving stale-by-design.
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) {
      throw new Error(`wire upstream ${res.status} for ${path}`);
    }
    return (await res.json()) as T;
  }

  /** GET /index.json — family vocabulary + counts. */
  rootManifest(): Promise<RootManifest> {
    return this.getJSON<RootManifest>("/index.json");
  }

  /** GET /{family}/index.json — enumerate a family's entry ids. */
  familyManifest(family: string): Promise<FamilyRow[]> {
    return this.getJSON<FamilyRow[]>(`/${encodeURIComponent(family)}/index.json`);
  }

  /** GET /search-index.json — verified entries only (trust beats breadth). */
  searchIndex(): Promise<SearchRow[]> {
    return this.getJSON<SearchRow[]>("/search-index.json");
  }

  /** GET /{id}.json — the full canonical entry. `id` may contain slashes
   *  (e.g. `tls-param/cipher-suites/0x1301`); each segment is encoded. */
  entry(id: string): Promise<Record<string, unknown>> {
    const path = id.split("/").map(encodeURIComponent).join("/");
    return this.getJSON<Record<string, unknown>>(`/${path}.json`);
  }

  /**
   * Rank the verified search index against a free-text query. Mirrors the
   * site's tiny client search: substring/token matching over id, title,
   * summary, and aliases, with field-weighted scoring. Optionally constrained
   * to one family. Returns hits sorted by descending score.
   */
  async search(query: string, family?: string, limit = 20): Promise<SearchHit[]> {
    const index = await this.searchIndex();
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(Boolean);

    const hits: SearchHit[] = [];
    for (const row of index) {
      if (family && row.family !== family) continue;

      const id = row.id.toLowerCase();
      const title = row.title.toLowerCase();
      const summary = row.summary.toLowerCase();
      const aliases = (row.aliases ?? []).map((a) => a.toLowerCase());

      let score = 0;
      for (const t of terms) {
        if (id === t) score += 100; // exact id match — the agent constructed it
        if (id.includes(t)) score += 25;
        if (aliases.some((a) => a === t)) score += 40;
        else if (aliases.some((a) => a.includes(t))) score += 12;
        if (title.includes(t)) score += 10;
        if (summary.includes(t)) score += 3;
      }
      // Whole-phrase bonus so multi-word queries beat scattered token hits.
      if (terms.length > 1) {
        if (title.includes(q)) score += 15;
        if (summary.includes(q)) score += 5;
      }
      if (score > 0) {
        hits.push({
          id: row.id,
          title: row.title,
          summary: row.summary,
          family: row.family,
          kind: row.kind,
          score,
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, Math.max(1, Math.min(limit, 100)));
  }
}
