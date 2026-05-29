// schema.mjs — GATE 1: schema.
//
// Each entry validates against schema/core.schema.json AND its declared
// ext sub-schema (schema/ext/{name}.v{N}.schema.json, derived from ext_type).
// Uses ajv when importable, else the structural fallback in lib.mjs.
//
// A JSON file that failed to parse is a failure here. A declared ext_type whose
// schema file does not yet exist is reported as a NOTE (not a failure): the
// content corpus can reference an ext_type before its schema lands, and the
// core schema's ext_type enum already gates the name. The ext shape is still
// checked the moment the schema file appears.

import { loadCoreSchema, resolveExtSchema, validate } from './lib.mjs';

export const name = 'schema';

export async function run(entries) {
  const failures = [];
  const notes = [];
  const core = await loadCoreSchema();
  const extCache = new Map();

  for (const { id, path, entry, loadError } of entries) {
    if (loadError) {
      failures.push({ id, path, message: `invalid JSON: ${loadError}` });
      continue;
    }

    const coreResult = await validate(core, entry);
    for (const e of coreResult.errors) {
      failures.push({ id, path, message: `core${e.path}: ${e.message}` });
    }

    const extType = entry.ext_type;
    if (!extType) continue; // core gate already flags the missing required field

    if (!extCache.has(extType)) extCache.set(extType, await resolveExtSchema(extType));
    const resolved = extCache.get(extType);

    if (!resolved.file) {
      failures.push({ id, path, message: `ext_type '${extType}' is not a resolvable schema name` });
      continue;
    }
    if (!resolved.exists) {
      notes.push(`ext schema not present yet for '${extType}' (${path}); ext shape unchecked until ${relFile(resolved.file)} lands`);
      continue;
    }

    const extResult = await validate(resolved.schema, entry.ext ?? {});
    for (const e of extResult.errors) {
      failures.push({ id, path, message: `ext(${extType})${e.path}: ${e.message}` });
    }
  }

  return { name, failures, notes };
}

function relFile(abs) {
  const i = abs.indexOf('/schema/');
  return i >= 0 ? abs.slice(i + 1) : abs;
}
