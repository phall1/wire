// lib.mjs — shared helpers for the data-integrity gates.
//
// DATA INTEGRITY ONLY. None of this drives a real implementation. We load the
// corpus, load the frozen core schema + versioned ext sub-schemas, and offer a
// validator that prefers ajv (a declared devDependency) but degrades to a
// built-in structural validator so the gates never hard-fail on a missing dep.

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '..', '..');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const SCHEMA_DIR = join(REPO_ROOT, 'schema');
export const EXT_SCHEMA_DIR = join(SCHEMA_DIR, 'ext');

// The literal retrieved/today date pinned by the project. Never compute at runtime.
export const TODAY = '2026-05-29';

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

/** Recursively collect every *.json file under data/. Returns absolute paths, sorted. */
export async function listDataFiles(dir = DATA_DIR) {
  const out = [];
  if (!existsSync(dir)) return out;
  const ents = await readdir(dir, { withFileTypes: true });
  for (const ent of ents) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listDataFiles(p)));
    else if (ent.isFile() && ent.name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

/**
 * Load every entry. A file that is not valid JSON is reported as a load error
 * (so the schema gate can fail on it) rather than throwing and aborting the run.
 * @returns {Promise<Array<{path:string, id:string, entry:object|null, loadError:string|null}>>}
 */
export async function loadEntries() {
  const files = await listDataFiles();
  const entries = [];
  for (const path of files) {
    const rel = path.slice(REPO_ROOT.length + 1);
    try {
      const raw = await readFile(path, 'utf8');
      const entry = JSON.parse(raw);
      entries.push({ path: rel, id: entry?.id ?? rel, entry, loadError: null });
    } catch (err) {
      entries.push({ path: rel, id: rel, entry: null, loadError: String(err.message ?? err) });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Schema loading
// ---------------------------------------------------------------------------

export async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadCoreSchema() {
  return loadJson(join(SCHEMA_DIR, 'core.schema.json'));
}

/**
 * Map an ext_type ("terminal-escape@1") to its schema file
 * (schema/ext/terminal-escape.v1.schema.json). The @version becomes ".v{N}".
 * Returns { extType, file, exists, schema|null }.
 */
export async function resolveExtSchema(extType) {
  const m = /^([a-z0-9-]+)@(\d+)$/.exec(extType ?? '');
  if (!m) return { extType, file: null, exists: false, schema: null };
  const [, name, version] = m;
  const file = join(EXT_SCHEMA_DIR, `${name}.v${version}.schema.json`);
  if (!existsSync(file)) return { extType, file, exists: false, schema: null };
  return { extType, file, exists: true, schema: await loadJson(file) };
}

// ---------------------------------------------------------------------------
// Validator: ajv when importable, structural fallback otherwise.
// ---------------------------------------------------------------------------

let _ajvFactory; // cached: () => validateFn  | null if unavailable

async function tryLoadAjv() {
  if (_ajvFactory !== undefined) return _ajvFactory;
  try {
    // The schemas declare draft 2020-12. ajv 8 ships that meta-schema in the
    // dedicated `ajv/dist/2020` build; the default `ajv` entry only knows
    // draft-07 and throws on a 2020-12 $schema. Prefer Ajv2020, fall back.
    let Ajv;
    try {
      const m2020 = await import('ajv/dist/2020.js');
      Ajv = m2020.default ?? m2020.Ajv2020 ?? m2020;
    } catch {
      const AjvMod = await import('ajv');
      Ajv = AjvMod.default ?? AjvMod.Ajv ?? AjvMod;
    }
    let addFormats = null;
    try {
      const fm = await import('ajv-formats');
      addFormats = fm.default ?? fm;
    } catch { /* formats optional; uri/date become no-ops */ }
    _ajvFactory = (schema) => {
      // strict:false + removing $schema avoids meta-schema lookup failures if a
      // draft we don't bundle slips in; structural constraints still apply.
      const { $schema, ...rest } = schema;
      const ajv = new Ajv({ allErrors: true, strict: false });
      if (addFormats) addFormats(ajv);
      return ajv.compile(rest);
    };
  } catch {
    _ajvFactory = null; // ajv not importable -> fallback
  }
  return _ajvFactory;
}

/** True iff ajv is importable in this environment. */
export async function ajvAvailable() {
  return (await tryLoadAjv()) !== null;
}

/**
 * Validate `data` against `schema`. Uses ajv if importable; else a built-in
 * structural validator that checks: type, required fields, enum membership,
 * and additionalProperties:false (the integrity-load-bearing constraints read
 * straight out of the schema). Returns { valid, errors: [{path, message}] }.
 */
export async function validate(schema, data) {
  const factory = await tryLoadAjv();
  if (factory) {
    const fn = factory(schema);
    const valid = fn(data);
    const errors = (fn.errors ?? []).map((e) => ({
      path: e.instancePath || '/',
      message: `${e.message}${e.params && Object.keys(e.params).length ? ' ' + JSON.stringify(e.params) : ''}`,
    }));
    return { valid, errors };
  }
  const errors = [];
  structuralValidate(schema, data, '', errors, schema);
  return { valid: errors.length === 0, errors };
}

/**
 * Minimal structural validator covering the constraints that matter for data
 * integrity: type, required, enum, additionalProperties:false, items, and the
 * top-level allOf if/then used by the core schema. Deliberately partial — it is
 * the safety net for when ajv is absent, not a full JSON-Schema implementation.
 */
function structuralValidate(schema, data, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;

  // $ref (local only)
  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#')) {
    const target = resolveRef(root, schema.$ref);
    if (target) structuralValidate(target, data, path, errors, root);
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, data))) {
      errors.push({ path: path || '/', message: `expected type ${types.join('|')}, got ${jsType(data)}` });
      return; // type mismatch -> deeper checks are noise
    }
  }

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => deepEqual(v, data))) {
      errors.push({ path: path || '/', message: `value not in enum ${JSON.stringify(schema.enum)}` });
    }
  }

  if (typeMatches('object', data) && data !== null) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!(key in data)) errors.push({ path: path || '/', message: `missing required property '${key}'` });
      }
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) errors.push({ path: `${path}/${key}`, message: `additional property '${key}' not allowed` });
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) structuralValidate(sub, data[key], `${path}/${key}`, errors, root);
    }
  }

  if (typeMatches('array', data) && schema.items && !Array.isArray(schema.items)) {
    if (typeof schema.minItems === 'number' && data.length < schema.minItems) {
      errors.push({ path: path || '/', message: `expected at least ${schema.minItems} item(s), got ${data.length}` });
    }
    data.forEach((el, i) => structuralValidate(schema.items, el, `${path}/${i}`, errors, root));
  }
  if (typeMatches('array', data) && typeof schema.minItems === 'number' && !schema.items) {
    if (data.length < schema.minItems) {
      errors.push({ path: path || '/', message: `expected at least ${schema.minItems} item(s), got ${data.length}` });
    }
  }

  // top-level allOf with if/then (core schema: tier C => attribution minItems 1)
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (branch.if && branch.then) {
        if (matchesCondition(branch.if, data)) {
          structuralValidate(branch.then, data, path, errors, root);
        }
      } else {
        structuralValidate(branch, data, path, errors, root);
      }
    }
  }
}

function matchesCondition(ifSchema, data) {
  // Only the subset the core schema uses: properties.<k>.const
  const props = ifSchema.properties ?? {};
  for (const [key, sub] of Object.entries(props)) {
    if (!data || typeof data !== 'object') return false;
    if ('const' in sub && !deepEqual(data[key], sub.const)) return false;
  }
  return true;
}

function resolveRef(root, ref) {
  const parts = ref.replace(/^#\/?/, '').split('/').filter(Boolean);
  let cur = root;
  for (const p of parts) {
    const key = p.replace(/~1/g, '/').replace(/~0/g, '~');
    cur = cur?.[key];
    if (cur === undefined) return null;
  }
  return cur;
}

function jsType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(t, v) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number';
    case 'integer': return Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return false;
  }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Misc helpers shared by gates
// ---------------------------------------------------------------------------

/** Extract the lowercased host from a URL string, or null if unparseable. */
export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Stable JSON for the machine-readable summary. */
export function toJSON(value) {
  return JSON.stringify(value, null, 2);
}
