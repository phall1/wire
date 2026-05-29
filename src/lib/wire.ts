// wire.ts — shared types, family vocabulary, and rendering helpers.
// The corpus lives in /data as one JSON file per entry; this is the glue the
// Astro pages and endpoints use so the human site and the agent JSON never drift.

export const SITE = {
  name: "wire",
  domain: "wire.phall.io",
  tagline:
    "the exact bytes that cross the wire — codes, sequences, and registry values, for humans and agents",
  github: "https://github.com/phall1/wire",
} as const;

/** Closed, curated family vocabulary (matches schema/core.schema.json). */
export const FAMILIES: Record<string, { label: string; blurb: string }> = {
  "terminal-osc": { label: "terminal-osc", blurb: "OSC operating-system commands" },
  "terminal-csi": { label: "terminal-csi", blurb: "CSI control sequences" },
  "terminal-dec-private-mode": {
    label: "terminal-dec-private-mode",
    blurb: "DEC private modes (CSI ? Pm h/l)",
  },
  "http-status": { label: "http-status", blurb: "HTTP status codes" },
  "http-method": { label: "http-method", blurb: "HTTP request methods" },
  "media-type": { label: "media-type", blurb: "IANA media types" },
  "uri-scheme": { label: "uri-scheme", blurb: "URI schemes" },
  port: { label: "port", blurb: "well-known service ports" },
  "tls-param": { label: "tls-param", blurb: "TLS parameters (cipher suites …)" },
  "dns-rrtype": { label: "dns-rrtype", blurb: "DNS resource-record types" },
  "cbor-tag": { label: "cbor-tag", blurb: "CBOR tags" },
  encoding: { label: "encoding", blurb: "encodings (base64, punycode …)" },
  "http-header": { label: "http-header", blurb: "HTTP header fields" },
  "link-relation": { label: "link-relation", blurb: "link relation types" },
  "well-known-uri": { label: "well-known-uri", blurb: "well-known URIs" },
  identifier: { label: "identifier", blurb: "unique identifier formats" },
  magic: { label: "magic", blurb: "file magic numbers / signatures" },
  "wire-format": { label: "wire-format", blurb: "binary wire formats & TLV" },
};

export interface Entry {
  id: string;
  family: string;
  namespace?: string;
  slug: string;
  title: string;
  summary: string;
  kind: string;
  aliases?: string[];
  status: string;
  verification: "verified" | "unverified" | "contested";
  tier: string;
  source_url: string;
  source_version: string;
  retrieved_date: string;
  attribution?: { claim_ref?: string; source_url: string; source_version?: string; note?: string }[];
  see_also?: string[];
  ext_type: string;
  ext: Record<string, any>;
  updated: string;
}

/** Render raw control bytes as printable \xNN so they never leak into HTML. */
export function showBytes(s: string | undefined | null): string {
  if (!s) return "";
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || c === 0x7f) {
      out += "\\x" + c.toString(16).padStart(2, "0");
    } else {
      out += ch;
    }
  }
  return out;
}

/** Link an RFC reference like "RFC9110" or "[RFC9110, Section 15.2.1]" to rfc-editor. */
export function rfcLink(ref: string): { label: string; href: string } | null {
  const m = ref.match(/RFC\s?(\d+)/i);
  if (!m) return null;
  return { label: ref, href: `https://www.rfc-editor.org/rfc/rfc${m[1]}` };
}

export const verifBadgeClass = (v: string) =>
  v === "verified" ? "ok" : v === "contested" ? "warn" : "";
