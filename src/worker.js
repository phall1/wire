// wire.phall.io — edge dual-serving shim over Workers Static Assets.
//
// One origin serves both humans (pre-rendered HTML) and agents (clean JSON) at
// the SAME stable id/permalink. The build emits, into ./dist, for every entry
// `{family}[/{namespace}]/{slug}`:
//     <id>.json   canonical fact bytes
//     <id>.html   pre-rendered human page
// plus top-level `redirects.json` (the 301 table) and the static index.json /
// _pagefind / llms.txt assets.
//
// Resolution order (matches DESIGN.md §6):
//   1. redirects.json  -> 301 under-specified guesses to the canonical id
//   2. explicit .json/.txt/.md suffix -> serve that asset, forced Content-Type
//      (overrides negotiation, so `curl` gets what it asked for)
//   3. bare path -> content-negotiate on Accept:
//        Accept: application/json  -> the entry's <id>.json bytes
//        otherwise                 -> the entry's <id>.html
//   4. anything else -> fall through to env.ASSETS.fetch (CSS, search, assets)
//
// Every negotiated/served response carries Vary: Accept, an ETag, a public
// Cache-Control, and permissive CORS so agents can fetch cross-origin.

const CACHE_CONTROL = "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Forced Content-Type for explicit suffix requests (suffix overrides Accept).
const SUFFIX_TYPES = {
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

// The redirect table is small and immutable per deploy; fetch it once via the
// ASSETS binding and memoize for the lifetime of the isolate.
let redirectsPromise = null;
function loadRedirects(env) {
  if (!redirectsPromise) {
    redirectsPromise = env.ASSETS.fetch(new URL("/redirects.json", "https://assets.local"))
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
  }
  return redirectsPromise;
}

// Normalize a request path to a redirect-table key: strip a trailing slash
// (but keep root "/") so "/osc/133/" and "/osc/133" map identically.
function normalizePath(pathname) {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

// Weak ETag derived from the entry's `updated` field when present, else a
// stable FNV-1a content hash of the bytes. Weak because HTML and JSON twins of
// one entry share semantic content but differ byte-for-byte.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function etagFor(bytes, updated) {
  const basis = updated != null ? String(updated) : bytes;
  return `W/"${fnv1a(basis)}"`;
}

function withHeaders(body, init, extra) {
  const headers = new Headers(init.headers || {});
  headers.set("Cache-Control", CACHE_CONTROL);
  headers.set("Vary", "Accept");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(body, { status: init.status || 200, headers });
}

// Fetch an asset by absolute dist path via the ASSETS binding.
function assetFetch(env, path) {
  return env.ASSETS.fetch(new URL(path, "https://assets.local"));
}

// Conditional-request short circuit: if the client's If-None-Match matches our
// computed ETag, answer 304 without a body.
function notModified(request, etag) {
  const inm = request.headers.get("If-None-Match");
  return inm != null && inm.split(",").some((t) => t.trim() === etag);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS preflight.
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...CORS_HEADERS, "Cache-Control": CACHE_CONTROL, Vary: "Accept" },
      });
    }

    // Only GET/HEAD are negotiated; let the asset server handle the rest.
    if (method !== "GET" && method !== "HEAD") {
      return env.ASSETS.fetch(request);
    }

    const path = normalizePath(url.pathname);

    // (1) Redirect table — 301 under-specified guesses to the canonical id.
    const redirects = await loadRedirects(env);
    const target = redirects[path];
    if (typeof target === "string") {
      const dest = new URL(target, url.origin);
      dest.search = url.search;
      return new Response(null, {
        status: 301,
        headers: {
          Location: dest.toString(),
          "Cache-Control": CACHE_CONTROL,
          ...CORS_HEADERS,
        },
      });
    }

    // (2) Explicit suffix overrides negotiation — forced Content-Type.
    const suffix = Object.keys(SUFFIX_TYPES).find((ext) => path.endsWith(ext));
    if (suffix) {
      const res = await assetFetch(env, path);
      if (!res.ok) return env.ASSETS.fetch(request);
      const bytes = await res.text();
      const etag = etagFor(bytes, res.headers.get("x-entry-updated"));
      if (notModified(request, etag)) {
        return withHeaders(null, { status: 304 }, { ETag: etag });
      }
      return withHeaders(method === "HEAD" ? null : bytes, { status: 200 }, {
        "Content-Type": SUFFIX_TYPES[suffix],
        ETag: etag,
      });
    }

    // (3) Bare path — content-negotiate JSON vs HTML on Accept.
    // We only negotiate paths that look like entry ids (no trailing file
    // extension); static assets keep their own extension and fall through.
    const looksLikeAsset = /\.[a-z0-9]+$/i.test(path);
    if (!looksLikeAsset && path !== "/") {
      const accept = request.headers.get("Accept") || "";
      const wantsJson = /\bapplication\/json\b/.test(accept);
      const variant = wantsJson ? `${path}.json` : `${path}.html`;
      const res = await assetFetch(env, variant);
      if (res.ok) {
        const bytes = await res.text();
        let updated = null;
        if (wantsJson) {
          try {
            updated = JSON.parse(bytes).updated;
          } catch {
            /* fall back to content hash */
          }
        }
        const etag = etagFor(bytes, updated);
        if (notModified(request, etag)) {
          return withHeaders(null, { status: 304 }, { ETag: etag });
        }
        return withHeaders(method === "HEAD" ? null : bytes, { status: 200 }, {
          "Content-Type": wantsJson
            ? "application/json; charset=utf-8"
            : "text/html; charset=utf-8",
          ETag: etag,
        });
      }
      // No entry under this id — fall through (may be a real static path,
      // else the asset server returns its 404).
    }

    // (4) Everything else — static assets, root, search, llms.txt.
    return env.ASSETS.fetch(request);
  },
};
