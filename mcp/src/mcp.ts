// mcp.ts — a minimal, dependency-free MCP server over the Streamable HTTP
// transport (spec 2025-06-18). Stateless: every JSON-RPC request is answered
// with a single `application/json` response, which the spec explicitly permits
// for servers that don't need SSE streaming or sessions. No Durable Object, no
// session ids — a pure function of the request and wire's live JSON.

import { WireClient } from "./wire-client";

export const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "wire-mcp", version: "1.0.0" } as const;
const SERVER_INSTRUCTIONS =
  "wire is a correctness-first reference for the exact bytes that cross the " +
  "wire: terminal escape sequences, HTTP status/methods, media types, URI " +
  "schemes, ports, TLS params, DNS rrtypes, CBOR tags, encodings, and more. " +
  "Use search() to find an entry, get(id) to fetch the full cited record, " +
  "list_families() for the vocabulary + counts, and get_family(family) to " +
  "enumerate one family. Every record carries provenance (source_url, " +
  "attribution[]) and a verification status — prefer 'verified' entries.";

// ── JSON-RPC 2.0 envelopes ────────────────────────────────────────────────
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}
interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// Standard JSON-RPC error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function ok(id: JsonRpcRequest["id"], result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function err(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, data } };
}

// ── Tool definitions (JSON Schema input, per MCP `tools/list`) ─────────────
const TOOLS = [
  {
    name: "search",
    title: "Search wire",
    description:
      "Search wire's verified corpus for protocol/standard entries. Returns " +
      "ranked matches (id, title, summary, family, kind). Optionally constrain " +
      "to one family. Use the returned id with get(id) for the full record.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text query, e.g. 'OSC 133', '418', 'base64', 'AAAA'.",
        },
        family: {
          type: "string",
          description:
            "Optional family filter, e.g. 'terminal-osc', 'http-status', " +
            "'encoding'. Use list_families() for the vocabulary.",
        },
        limit: {
          type: "integer",
          description: "Max hits to return (1-100, default 20).",
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get",
    title: "Get entry",
    description:
      "Fetch the full canonical JSON for one wire entry by its id " +
      "(e.g. 'terminal-osc/133', 'http-status/418', 'encoding/base64'). " +
      "Includes byte sequences (with \\u001b-style escapes), the typed ext " +
      "object, provenance, and per-claim attribution.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The entry id, '{family}[/{namespace}]/{slug}'.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "list_families",
    title: "List families",
    description:
      "List wire's closed family vocabulary with a blurb and entry count for " +
      "each, plus the total corpus size. The starting point for discovery.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_family",
    title: "Get family manifest",
    description:
      "Enumerate every entry id in one family (id, title, status, " +
      "verification, kind) — the manifest an agent walks instead of crawling.",
    inputSchema: {
      type: "object",
      properties: {
        family: {
          type: "string",
          description:
            "A family name from list_families(), e.g. 'terminal-osc', 'port'.",
        },
      },
      required: ["family"],
    },
  },
] as const;

/** Wrap any JSON-serializable value as MCP unstructured text content. */
function textResult(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError: false,
  };
}

function callError(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Dispatch a `tools/call` to the wire shim. Returns an MCP tool result. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  wire: WireClient,
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  switch (name) {
    case "search": {
      const query = typeof args.query === "string" ? args.query : "";
      if (!query.trim()) return callError("search requires a non-empty 'query' string.");
      const family = typeof args.family === "string" ? args.family : undefined;
      const limit = typeof args.limit === "number" ? args.limit : 20;
      const hits = await wire.search(query, family, limit);
      return textResult({ query, family: family ?? null, count: hits.length, results: hits });
    }
    case "get": {
      const id = typeof args.id === "string" ? args.id : "";
      if (!id.trim()) return callError("get requires an 'id' string.");
      try {
        return textResult(await wire.entry(id.trim()));
      } catch (e) {
        return callError(
          `No entry found for id '${id}'. Use search() or get_family() to find a valid id. (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
      }
    }
    case "list_families": {
      const manifest = await wire.rootManifest();
      return textResult({
        total: manifest.total,
        families: manifest.families.map((f) => ({
          family: f.family,
          blurb: f.blurb,
          count: f.count,
        })),
      });
    }
    case "get_family": {
      const family = typeof args.family === "string" ? args.family : "";
      if (!family.trim()) return callError("get_family requires a 'family' string.");
      try {
        const rows = await wire.familyManifest(family.trim());
        return textResult({ family: family.trim(), count: rows.length, entries: rows });
      } catch (e) {
        return callError(
          `No family '${family}'. Use list_families() for the vocabulary. (${
            e instanceof Error ? e.message : String(e)
          })`,
        );
      }
    }
    default:
      return callError(`Unknown tool: ${name}`);
  }
}

/**
 * Handle one parsed JSON-RPC message. Returns the response object, or `null`
 * for notifications/responses (which take no reply — the caller answers 202).
 */
async function handleRpc(
  msg: JsonRpcRequest,
  wire: WireClient,
): Promise<JsonRpcResponse | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(msg.id ?? null, INVALID_REQUEST, "Invalid JSON-RPC 2.0 request.");
  }

  // Notifications (no id) require no response under the spec.
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: SERVER_INSTRUCTIONS,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // acknowledged via HTTP 202 by the caller

    case "ping":
      return ok(msg.id, {});

    case "tools/list":
      return ok(msg.id, { tools: TOOLS });

    case "tools/call": {
      const params = msg.params ?? {};
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments as Record<string, unknown>) ?? {};
      if (!name) return err(msg.id, INVALID_PARAMS, "tools/call requires params.name.");
      if (!TOOLS.some((t) => t.name === name)) {
        return err(msg.id, METHOD_NOT_FOUND, `Unknown tool: ${name}`);
      }
      const result = await callTool(name, args, wire);
      return ok(msg.id, result);
    }

    default:
      if (isNotification) return null; // ignore unknown notifications
      return err(msg.id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/**
 * Process a Streamable HTTP POST body (a single JSON-RPC message or a batch)
 * and produce the HTTP response. Stateless `application/json` mode.
 */
export async function handleMcpPost(body: unknown, wire: WireClient): Promise<Response> {
  const jsonHeaders = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  };

  // Batch: array of messages → array of (non-null) responses.
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return json(err(null, INVALID_REQUEST, "Empty batch."), 400);
    }
    const responses: JsonRpcResponse[] = [];
    for (const m of body) {
      const r = await handleRpc(m as JsonRpcRequest, wire);
      if (r) responses.push(r);
    }
    // If the batch was entirely notifications, there is nothing to return.
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: jsonHeaders });
    }
    return new Response(JSON.stringify(responses), { status: 200, headers: jsonHeaders });
  }

  // Single message.
  const response = await handleRpc(body as JsonRpcRequest, wire);
  if (!response) {
    // Notification or response input → 202 Accepted, no body (per spec).
    return new Response(null, { status: 202, headers: jsonHeaders });
  }
  return new Response(JSON.stringify(response), { status: 200, headers: jsonHeaders });
}

function json(payload: JsonRpcResponse, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

export { PARSE_ERROR, INVALID_REQUEST, err };
export type { JsonRpcResponse };
