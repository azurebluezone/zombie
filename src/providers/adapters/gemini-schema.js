// Gemini - JSON Schema translation for `tools[].functionDeclarations[].parameters`.
//
// WHY THIS FILE EXISTS
// Gemini accepts only a narrow subset of JSON Schema for tool parameters and
// rejects the whole request with HTTP 400 INVALID_ARGUMENT as soon as it meets an
// unknown keyword. The previous implementation simply DELETED every keyword it did
// not recognise, which had two consequences:
//   1. it dropped keywords the provider actually accepts (`not`), and
//   2. it sent keywords the provider rejects (`$ref`, or `type` as a list), which
//      made Gemini reject the ENTIRE request - the "complex schema" failure.
// On top of that, deleting `$ref` also erased the structure behind it, so tools
// coming from MCP servers reached the model as an empty object.
//
// This module TRANSLATES instead of deleting:
//   $ref / $defs / definitions  -> inlined (Gemini rejects "$ref" outright)
//   type:["string","null"]      -> a single type plus `nullable`
//   const:X                     -> enum:[X]
//   missing `type`              -> inferred from properties / items
// Keywords with no Gemini equivalent (`additionalProperties`, `prefixItems`, ...)
// are dropped, but local argument validation keeps running on the ORIGINAL schema,
// so dropping never weakens enforcement.

/**
 * Evidence for Gemini function-declaration schemas.
 * Regenerate with the elimination probe before changing a verdict.
 *
 * Probe (2026-10-16, model gemini-3.5-flash): 45 candidate keywords were placed as
 * separate properties of ONE functionDeclaration, and the provider answered
 * HTTP 400 naming 24 offenders - every name it did not report is proto-valid.
 * The structured-output docs advertise `additionalProperties` and `prefixItems`
 * for `responseSchema`, but the function-declaration proto rejects both, and it
 * also rejects a repeated `type` ("Proto field is not repeating, cannot start list").
 */
export const GEMINI_SCHEMA_SUPPORT = Object.freeze({
  probedAt: '2026-10-16',
  probedModel: 'gemini-3.5-flash',
  method: 'live generateContent probe, iterative elimination',
  accepted: Object.freeze([
    'type', 'title', 'description', 'enum', 'format', 'minimum', 'maximum',
    'minItems', 'maxItems', 'anyOf', 'oneOf', 'allOf', 'not', 'pattern', 'default',
    'propertyOrdering', 'minLength', 'maxLength', 'minProperties', 'maxProperties',
    'nullable', 'properties', 'required', 'items'
  ]),
  rejected: Object.freeze([
    'additionalProperties', 'additionalItems', 'prefixItems', 'uniqueItems',
    'contains', 'multipleOf', 'patternProperties', 'propertyNames',
    'dependentRequired', 'dependentSchemas', 'unevaluatedProperties', 'examples',
    'readOnly', 'writeOnly', 'deprecated', 'if', 'then', 'else', 'const',
    '$comment', '$schema', '$id', '$ref', '$defs', 'definitions'
  ]),
  translated: Object.freeze({
    $ref: 'inlined from the schema root; a real cycle falls back to the shape only',
    typeArray: 'collapsed to one type plus `nullable`, or to `anyOf` for real unions',
    const: 'rewritten as enum:[value]'
  })
});

/** Keywords whose value is a map of sub-schemas. */
const SUBSCHEMA_MAP = new Set(['properties']);
/** Keywords whose value is a single sub-schema. */
const SUBSCHEMA_ONE = new Set(['items', 'not']);
/** Keywords whose value is a list of sub-schemas. */
const SUBSCHEMA_LIST = new Set(['anyOf', 'oneOf', 'allOf']);

const MAX_DEPTH = 24;
const MAX_REF_HOPS = 16;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve a local JSON pointer (`#`, `#/$defs/x`, `#/properties/a`) against the root schema. */
export function resolvePointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) return undefined;
  const rest = ref.slice(1);
  if (rest === '') return root;
  if (!rest.startsWith('/')) return undefined;
  let node = root;
  for (const rawSegment of rest.slice(1).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlainObject(node) && !Array.isArray(node)) return undefined;
    node = node[segment];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * Follow `$ref` chains and merge sibling keywords (JSON Schema 2019+ allows
 * keywords next to `$ref`). A cycle is reported instead of followed forever;
 * `consumedRefs` must stay "resolving" for every child schema so a recursive
 * schema expands exactly one level and then collapses to its shape.
 */
function dereference(schema, ctx) {
  if (typeof schema.$ref !== 'string') return { schema, cyclic: false, consumedRefs: null };
  const siblings = {};
  for (const [key, value] of Object.entries(schema)) if (key !== '$ref') siblings[key] = value;
  const consumed = new Set();
  const merged = {};
  let current = schema;
  let hops = 0;
  while (typeof current?.$ref === 'string') {
    const ref = current.$ref;
    if (consumed.has(ref) || hops >= MAX_REF_HOPS || ctx.resolving.has(ref)) {
      const target = resolvePointer(ctx.root, ref);
      return { schema: shapeOnlyFrom(target, siblings), cyclic: true, consumedRefs: consumed };
    }
    consumed.add(ref);
    hops += 1;
    const target = resolvePointer(ctx.root, ref);
    if (!isPlainObject(target)) return { schema: shapeOnlyFrom(undefined, siblings), cyclic: true, consumedRefs: consumed };
    for (const [key, value] of Object.entries(target)) if (!(key in merged)) merged[key] = value;
    current = target;
  }
  for (const [key, value] of Object.entries(current)) if (!(key in merged)) merged[key] = value;
  for (const [key, value] of Object.entries(siblings)) merged[key] = value;
  return { schema: merged, cyclic: false, consumedRefs: consumed };
}

function declaredType(schema) {
  if (!isPlainObject(schema)) return undefined;
  const type = Array.isArray(schema.type) ? schema.type.filter(t => t !== 'null')[0] : schema.type;
  return type === 'null' ? undefined : type;
}

/** Last resort for a recursive schema: keep the shape, drop the cycle. */
function shapeOnlyFrom(target, partial = {}) {
  const out = {};
  for (const key of ['type', 'title', 'description', 'nullable', 'enum', 'format', 'default', 'pattern']) {
    const value = partial[key] ?? (isPlainObject(target) ? target[key] : undefined);
    if (value !== undefined) out[key] = value;
  }
  if (!out.type && !out.enum) out.type = declaredType(target) ?? inferType(target ?? {}) ?? 'object';
  return out;
}

function inferType(schema) {
  if (!isPlainObject(schema)) return undefined;
  if ('properties' in schema || 'required' in schema || 'additionalProperties' in schema || 'minProperties' in schema || 'maxProperties' in schema) return 'object';
  if ('items' in schema || 'prefixItems' in schema || 'minItems' in schema || 'maxItems' in schema || 'uniqueItems' in schema || 'contains' in schema) return 'array';
  return undefined;
}

function collapseTypeArray(value, accepted) {
  const list = [...new Set(value)];
  const nonNull = list.filter(type => type !== 'null');
  const allowsNull = list.includes('null');
  if (nonNull.length === 1) return { type: nonNull[0], ...(allowsNull && accepted.has('nullable') ? { nullable: true } : {}) };
  if (nonNull.length > 1) return { anyOf: nonNull.map(type => ({ type })) };
  return {};
}

/**
 * Translate one schema node into a schema Gemini accepts.
 * @param {object} schema JSON Schema (native tool schema or an MCP server schema)
 * @param {{root?:object,depth?:number,resolving?:Set<string>,accepted?:Set<string>}} [options]
 */
export function toGeminiSchema(schema, options = {}) {
  const ctx = {
    root: options.root ?? schema,
    depth: options.depth ?? 0,
    resolving: options.resolving ?? new Set(),
    accepted: options.accepted ?? new Set(GEMINI_SCHEMA_SUPPORT.accepted)
  };
  return normalise(schema, ctx);
}

function normalise(schema, ctx) {
  // JSON Schema allows a boolean schema (`true` = anything). Gemini expects an
  // object, so the closest expressible equivalent is an empty schema.
  if (typeof schema === 'boolean') return {};
  if (!isPlainObject(schema)) {
    if (Array.isArray(schema)) return schema.map(item => normalise(item, ctx));
    return schema;
  }
  if (ctx.depth > MAX_DEPTH) return {};

  const { schema: source, cyclic, consumedRefs } = dereference(schema, ctx);
  if (cyclic) return shapeOnlyFrom(source);

  const childCtx = {
    root: ctx.root,
    depth: ctx.depth + 1,
    resolving: consumedRefs?.size ? new Set([...ctx.resolving, ...consumedRefs]) : ctx.resolving,
    accepted: ctx.accepted
  };
  const out = {};

  // `type` first: the provider rejects a repeated field, so a list must collapse.
  if (Array.isArray(source.type)) Object.assign(out, collapseTypeArray(source.type, ctx.accepted));
  else if (typeof source.type === 'string' && source.type !== 'null') out.type = source.type;
  if (!out.type && !out.anyOf) {
    const inferred = inferType(source);
    if (inferred) out.type = inferred;
  }
  if (source.nullable === true && ctx.accepted.has('nullable')) out.nullable = true;

  for (const [key, value] of Object.entries(source)) {
    if (key === 'type' || key === '$ref' || key === 'nullable') continue;
    if (key === 'const') {
      if (!('enum' in source)) out.enum = [value];
      continue;
    }
    if (!ctx.accepted.has(key)) continue; // provider rejects it and has no equivalent
    if (SUBSCHEMA_MAP.has(key) && isPlainObject(value)) {
      const mapped = {};
      for (const [name, sub] of Object.entries(value)) mapped[name] = normalise(sub, childCtx);
      out[key] = mapped;
    } else if (SUBSCHEMA_ONE.has(key)) {
      // Draft-07 allows `items` to be a LIST (tuple form). Gemini expects a single
      // schema there and rejects a list, so a tuple becomes a union of its members.
      out[key] = Array.isArray(value)
        ? (value.length === 1 ? normalise(value[0], childCtx) : { anyOf: value.map(item => normalise(item, childCtx)) })
        : normalise(value, childCtx);
    } else if (SUBSCHEMA_LIST.has(key)) {
      out[key] = Array.isArray(value) ? value.map(item => normalise(item, childCtx)) : value;
    } else if (key === 'required' && Array.isArray(value)) {
      if (value.length) out.required = value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Convenience wrapper for a full function declaration. */
export function toGeminiParameters(parameters) {
  const schema = isPlainObject(parameters) ? parameters : {};
  return toGeminiSchema(schema, { root: schema });
}

/** True when `key` may be sent to Gemini inside function-declaration parameters. */
export function isGeminiSchemaKeyword(key) {
  return GEMINI_SCHEMA_SUPPORT.accepted.includes(key);
}
