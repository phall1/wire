// index.ts — wire-mcp Worker entry.
//
// A standalone Cloudflare Worker (separate from the wire Pages site) that
// exposes wire's corpus to agents over the Model Context Protocol. It is a
// stateless shim: it holds no data of its own, fetching wire's live static JSON
// (https://wire.phall.io/...) on every request, so the MCP surface and the curl
// surface are the identical bytes and can never drift.
//
// Transport: MCP Streamable HTTP (spec 2025-06-18) at POST /mcp, answered with a
// single application/json JSON-RPC response. No sessions, no SSE, no Durable
// Object — keeping with wire's "small and snappy" design principle.

import { handleMcpPost, PARSE_ERROR, err } from "./mcp";
import { WireClient, DEFAULT_ORIGIN } from "./wire-client";

interface Env {
  /** Optional override of the upstream origin (defaults to wire.phall.io). */
  WIRE_ORIGIN?: string;
}

const MCP_PATH = "/mcp";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-max-age": "86400",
};

const LANDING = `wire-mcp — Model Context Protocol server for wire.phall.io

A stateless MCP server over wire's live JSON. Connect an MCP client to:

    ${"{this-worker-url}"}${MCP_PATH}

Transport: Streamable HTTP (MCP 2025-06-18). Tools:
  - search(query, family?, limit?)  ranked id + title + summary
  - get(id)                         the full canonical entry JSON
  - list_families()                 family vocabulary + counts
  - get_family(family)              one family's manifest

Source data is fetched live from ${DEFAULT_ORIGIN}; this Worker stores nothing.
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const wire = new WireClient(env.WIRE_ORIGIN || DEFAULT_ORIGIN);

    // Preflight for any path.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === MCP_PATH) {
      // POST: the JSON-RPC request channel (the only one a stateless server needs).
      if (request.method === "POST") {
        // Per spec the client MUST Accept both application/json and
        // text/event-stream. We only ever reply with JSON, which is allowed.
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify(err(null, PARSE_ERROR, "Invalid JSON in request body.")),
            { status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS } },
          );
        }
        const res = await handleMcpPost(body, wire);
        // Fold CORS onto the protocol response.
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
        return res;
      }

      // GET: the spec lets a server decline the optional server→client SSE
      // stream with 405. A stateless server has nothing to push, so we do.
      if (request.method === "GET") {
        return new Response("This MCP endpoint does not offer an SSE stream; POST JSON-RPC to /mcp.", {
          status: 405,
          headers: { allow: "POST, OPTIONS", ...CORS_HEADERS },
        });
      }

      // DELETE: session teardown — nothing to tear down in a stateless server.
      if (request.method === "DELETE") {
        return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", ...CORS_HEADERS } });
      }

      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: "POST, GET, OPTIONS", ...CORS_HEADERS },
      });
    }

    // Health check / human-facing landing.
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(LANDING, {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS },
      });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};
