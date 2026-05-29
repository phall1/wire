// encoding-exec.mjs — GATE 4: encoding test-vector EXECUTION.
//
// THE ONE GATE THAT RUNS CODE. For every entry with ext_type 'encoding@1', we
// actually execute each declared test_vector input -> output in Node and assert
// equality. Codec facts are proven, not asserted (DESIGN §5.4).
//
// Supported algorithms (selected by ext.algorithm or per-vector vector.algorithm):
//   base64, base64url, base32 (RFC 4648), base16 (hex), percent-encoding,
//   punycode (IDNA, via WHATWG URL with a node:punycode label fallback).
//
// test_vector shape (tolerant; all reasonable field names accepted):
//   {
//     name?, algorithm?, direction?: "encode"|"decode" (default "encode"),
//     input: <string>, expected|output: <string>,
//     input_encoding?: "utf8"|"hex"|"base64"|"latin1" (how to read `input`
//                       bytes when decoding/encoding binary; default "utf8"),
//   }
//
// No encoding@1 entries exist yet; this gate then reports 0 vectors executed.

export const name = 'encoding-exec';

export async function run(entries) {
  const failures = [];
  let vectorCount = 0;

  for (const { id, path, entry, loadError } of entries) {
    if (loadError) continue;
    if (entry.ext_type !== 'encoding@1') continue;

    const ext = entry.ext ?? {};
    const defaultAlgo = ext.algorithm ?? ext.algo ?? null;
    const vectors = collectVectors(ext);
    const add = (message) => failures.push({ id, path, message });

    if (vectors.length === 0) {
      add(`ext_type 'encoding@1' but no test_vectors found to execute`);
      continue;
    }

    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      vectorCount += 1;
      const label = v.name ? `'${v.name}'` : `#${i}`;
      const algo = (v.algorithm ?? v.algo ?? defaultAlgo ?? '').toLowerCase();
      const direction = (v.direction ?? 'encode').toLowerCase();
      const expected = v.expected ?? v.output;
      if (typeof expected !== 'string') {
        add(`test_vector ${label}: missing string 'expected'/'output'`);
        continue;
      }
      if (typeof v.input !== 'string') {
        add(`test_vector ${label}: missing string 'input'`);
        continue;
      }
      let actual;
      try {
        actual = await execVector(algo, direction, v);
      } catch (err) {
        add(`test_vector ${label} (${algo} ${direction}): execution error: ${err.message}`);
        continue;
      }
      if (actual !== expected) {
        add(`test_vector ${label} (${algo} ${direction}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    }
  }

  return { name, failures, notes: [`${vectorCount} encoding test-vector(s) executed`] };
}

/** Gather test vectors from the various plausible locations in ext. */
function collectVectors(ext) {
  const fromArr = (a) => (Array.isArray(a) ? a : []);
  return [
    ...fromArr(ext.test_vectors),
    ...fromArr(ext.testVectors),
    ...fromArr(ext.vectors),
  ];
}

/** Read `input` into a Buffer using the declared input_encoding (default utf8). */
function inputBuffer(v) {
  const enc = (v.input_encoding ?? 'utf8').toLowerCase();
  const map = { utf8: 'utf8', 'utf-8': 'utf8', hex: 'hex', base64: 'base64', latin1: 'latin1', binary: 'latin1', ascii: 'ascii' };
  const nodeEnc = map[enc];
  if (!nodeEnc) throw new Error(`unsupported input_encoding '${v.input_encoding}'`);
  return Buffer.from(v.input, nodeEnc);
}

async function execVector(algo, direction, v) {
  switch (algo) {
    case 'base64': return direction === 'decode' ? b64Decode(v.input, false) : inputBuffer(v).toString('base64');
    case 'base64url': return direction === 'decode' ? b64Decode(v.input, true) : base64UrlEncode(inputBuffer(v));
    case 'base32': return direction === 'decode' ? base32Decode(v.input) : base32Encode(inputBuffer(v));
    case 'base16':
    case 'hex': return direction === 'decode' ? Buffer.from(v.input, 'hex').toString('utf8') : inputBuffer(v).toString('hex');
    case 'percent':
    case 'percent-encoding':
    case 'percent_encoding':
    case 'url':
      return direction === 'decode' ? decodeURIComponent(v.input) : encodeURIComponent(v.input);
    case 'punycode':
    case 'idna':
      return direction === 'decode' ? toUnicode(v.input) : toASCII(v.input);
    default:
      throw new Error(`unknown algorithm '${algo}'`);
  }
}

// --- base64url -------------------------------------------------------------
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64Decode(s, url) {
  let t = url ? s.replace(/-/g, '+').replace(/_/g, '/') : s;
  return Buffer.from(t, 'base64').toString('utf8');
}

// --- base32 (RFC 4648, uppercase, '=' padding) -----------------------------
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  while (out.length % 8 !== 0) out += '=';
  return out;
}
function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 char '${ch}'`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// --- punycode / IDNA -------------------------------------------------------
// Prefer the WHATWG URL (UTS-46) for full domains. Fall back to node:punycode
// for bare-label conversions the URL parser can't round-trip on its own.
// node:punycode is loaded LAZILY (only when a punycode/idna vector is actually
// executed) so its deprecation warning never fires on corpora without one.
let PUNY; // undefined=unloaded, null=unavailable, object=loaded
async function loadPuny() {
  if (PUNY !== undefined) return PUNY;
  try {
    const m = await import('node:punycode');
    PUNY = m.default ?? m;
  } catch {
    PUNY = null;
  }
  return PUNY;
}

async function toASCII(domain) {
  try {
    const u = new URL(`http://${domain}/`);
    if (u.hostname) return u.hostname;
  } catch { /* fall through to punycode */ }
  const p = await loadPuny();
  if (p?.toASCII) return p.toASCII(domain);
  throw new Error('punycode toASCII unavailable and URL parse failed');
}
async function toUnicode(domain) {
  const p = await loadPuny();
  if (p?.toUnicode) return p.toUnicode(domain);
  throw new Error('punycode toUnicode unavailable');
}
