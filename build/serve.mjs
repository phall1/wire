#!/usr/bin/env node
// Local preview server over dist/. Node built-ins only. Mirrors production
// dual-serving: (1) redirects.json -> 301; (2) explicit .json/.txt suffix
// overrides negotiation; (3) Accept negotiation on a bare path -> json or html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = process.env.PORT || 8787;

const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

let redirects = {};
try { redirects = JSON.parse(await readFile(path.join(DIST, "redirects.json"), "utf8")); } catch {}

async function send(res, file, code = 200) {
  const body = await readFile(file);
  res.writeHead(code, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(body);
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(req.url.split("?")[0]);
    if (redirects[url]) { res.writeHead(301, { Location: redirects[url] }); return res.end(); }

    // Explicit suffix overrides negotiation.
    if (/\.(json|txt|css|js|html)$/.test(url)) {
      const f = path.join(DIST, url);
      if (await exists(f)) return send(res, f);
      res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404");
    }

    const wantsJson = (req.headers.accept || "").includes("application/json");
    const clean = url.replace(/\/$/, "");
    if (wantsJson) {
      const jf = path.join(DIST, clean + ".json");
      if (await exists(jf)) { res.setHeader("Vary", "Accept"); return send(res, jf); }
      const idxJson = path.join(DIST, clean, "index.json");
      if (await exists(idxJson)) { res.setHeader("Vary", "Accept"); return send(res, idxJson); }
    }
    const html = path.join(DIST, clean, "index.html");
    if (await exists(html)) { res.setHeader("Vary", "Accept"); return send(res, html); }

    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("404 " + url);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" }); res.end("500 " + e.message);
  }
}).listen(PORT, () => console.log(`serving dist/ at http://localhost:${PORT}`));
