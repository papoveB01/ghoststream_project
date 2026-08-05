// Response-schema translation: the repo's Gemini dialect → Anthropic's strict
// JSON Schema. Part of the ADR-0006 provider migration.
//
// WHY THIS EXISTS. Every one of the 26 `responseSchema` objects in src/ is
// written in Google's OpenAPI-3.0 flavour. Anthropic's
// `output_config.format.json_schema` is standard JSON Schema with a strict
// validator, and the two disagree in three places. All three were established
// against the live API on 2026-08-05 with claude-haiku-4-5 — the third by the
// smoke check itself, on its first run, against three real schemas:
//
//   1. MISSING `additionalProperties` IS A HARD 400.
//        "For 'object' type, 'additionalProperties' must be explicitly set to
//         false"
//      Not one schema in this repo sets it, so without this module every
//      structured-output task 400s on its first request after a provider flip.
//      Loud, at least.
//
//   2. `nullable: true` IS A 400 ON OBJECTS AND SILENTLY IGNORED EVERYWHERE
//      ELSE — which is the dangerous half.
//        {type:'object', nullable:true} → 400 "property 'nullable' is not supported"
//        {type:'array',  nullable:true} → 200, and the model returns [] forever
//        {type:'string', nullable:true} → 200, and the model returns "" forever
//      Gemini honours nullable; Claude, handed the same schema, cannot express
//      "there wasn't one". That distinction is load-bearing here:
//      analysis.js's `objection`/`agreement` are documented as "null = the
//      prospect raised none — never invent one", and proposals.js reads a null
//      `citations` as "this section cites nothing". Under a silent-ignore the
//      model is forced to fabricate an objection to satisfy the schema, and
//      nothing anywhere reports a problem.
//      The standard spelling — `type: ['object', 'null']` — is accepted and the
//      model does emit null (live-verified), so the fix is a translation, not a
//      capability loss.
//
//   3. …EXCEPT ON AN ENUM, where that same union spelling is itself a 400.
//        {type:['string','null'], enum:[...]} → 400 "Enum value 'A' does not
//                                                    match declared type"
//      A nullable enum has to become `anyOf: [{type, enum}, {type:'null'}]`.
//      Three schemas hit this — discovery.competitorProducts, kb.preview and
//      companies.productFit — and in all three the null branch is the one that
//      stops the model guessing (a product id, a KB category) when the right
//      answer is "none of these".
//
// Copies rather than mutating: every caller passes a module-level schema
// constant shared across requests, and Gemini call sites still send the
// original. Mutating in place would rewrite the Gemini contract from an
// Anthropic call site — the exact cross-provider bleed this migration must not
// have.
//
// Precisely: every object node is rebuilt and every array value is sliced, so
// no container is shared with the input. Array ELEMENTS that are themselves
// objects and sit outside a subschema position (an object-valued `enum` member,
// say) are still shared by reference — no schema in this repo has one, and
// nothing downstream mutates the result, but do not assume the returned tree is
// safe to edit in place.

// A node is an object schema if it says so, or unions object in, or is a bare
// `{properties: {...}}` with the type left implicit.
function isObjectNode(node) {
  if (node.type === 'object') return true;
  if (Array.isArray(node.type) && node.type.includes('object')) return true;
  return node.type === undefined && node.properties !== undefined;
}

// `nullable: true` → the null variant folded into `type`. Returns the new type,
// or undefined when there is nothing to fold into (see the warning below).
function unionWithNull(type) {
  if (typeof type === 'string') return type === 'null' ? type : [type, 'null'];
  if (Array.isArray(type)) return type.includes('null') ? type : [...type, 'null'];
  return undefined;
}

// Keys carrying subschemas. Anything else is copied through untouched, so a
// keyword this module has never heard of still reaches the API rather than
// being quietly dropped on the way.
//
// The lists have to be EXHAUSTIVE, not "the ones we use". A subschema-bearing
// keyword that falls through to the copy branch is not passed through
// harmlessly — it is passed through UNTRANSLATED, which means an unsealed
// object (a 400) and a surviving `nullable` (the silent half) inside it. That
// is the corruption this module exists to prevent, reintroduced by omission.
// `additionalProperties` appears here because it takes either a boolean or a
// schema; convert() returns non-objects untouched, so the boolean form is safe.
const SUBSCHEMA_KEY = new Set([
  'items', 'additionalItems', 'contains', 'not', 'if', 'then', 'else',
  'additionalProperties', 'propertyNames', 'unevaluatedProperties', 'unevaluatedItems',
  'contentSchema',
]);
const SUBSCHEMA_MAP = new Set([
  'properties', 'patternProperties', '$defs', 'definitions',
  'dependentSchemas', 'dependencies',
]);
const SUBSCHEMA_LIST = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function convert(node, path, warnings) {
  if (Array.isArray(node)) return node.map((n, i) => convert(n, `${path}[${i}]`, warnings));
  if (!node || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'nullable') continue; // handled below
    if (SUBSCHEMA_KEY.has(key)) out[key] = convert(value, `${path}.${key}`, warnings);
    else if (SUBSCHEMA_MAP.has(key) && value && typeof value === 'object') {
      out[key] = {};
      for (const [name, sub] of Object.entries(value)) {
        // `properties` is elided from the path because that is how a reader
        // refers to a field ($.objection, not $.properties.objection); every
        // other container is named, so a warning under `$defs.Foo` cannot be
        // mistaken for one on a property called Foo.
        const child = key === 'properties' ? `${path}.${name}` : `${path}.${key}.${name}`;
        out[key][name] = convert(sub, child, warnings);
      }
    } else if (SUBSCHEMA_LIST.has(key) && Array.isArray(value)) {
      out[key] = value.map((sub, i) => convert(sub, `${path}.${key}[${i}]`, warnings));
    // Arrays are COPIED, not aliased. `enum` and `required` reach this branch,
    // and several of them are live application state, not schema-only data:
    // kb.assessment's key enum IS `assessment.js`'s AXIS_KEYS, which that module
    // also uses for post-parse validation and axis ordering; kb.preview's is
    // preview.js's KB_CATEGORIES. Sharing them would mean any future
    // post-processing pass on the Anthropic side rewrites both the Gemini
    // contract and the app's own validation lists, globally, for every tenant.
    } else out[key] = Array.isArray(value) ? value.slice() : value;
  }

  if (node.nullable === true) {
    if (Array.isArray(out.enum)) {
      // A nullable ENUM cannot use the union spelling. Every obvious form is a
      // 400 (live-probed 2026-08-05, all four on claude-haiku-4-5):
      //   {type:['string','null'], enum:['A','B']}       → "Enum value 'A' does not
      //                                                     match declared type"
      //   {type:['string','null'], enum:['A','B',null]}  → same
      //   {type:'string',          enum:['A','B',null]}  → "Enum value None does not
      //                                                     match declared type 'string'"
      //   {anyOf:[{type:'string',enum:['A','B']},{type:'null'}]}  → OK
      // The first of those was what the live smoke check rejected on its first
      // run, on three real schemas at once — discovery.competitorProducts,
      // kb.preview and companies.productFit. `description` deliberately stays
      // on the OUTER node: it is the only place the model reliably reads it,
      // and every one of those three uses it to explain when null is right.
      const branch = { enum: out.enum };
      if (out.type !== undefined) branch.type = out.type;
      delete out.type;
      delete out.enum;
      out.anyOf = [branch, { type: 'null' }];
    } else {
      const unioned = unionWithNull(out.type);
      if (unioned !== undefined) {
        out.type = unioned;
      } else if (isObjectNode(out)) {
        // `{properties: {...}, nullable: true}` — no explicit `type`, but the
        // seal below is about to treat it as an object, so null IS expressible.
        // Warning here instead would have the module contradict itself about
        // the same node in the same pass, and drop nullability on the shape a
        // hand-written sub-schema most often takes.
        out.type = ['object', 'null'];
      } else if (Array.isArray(out.anyOf)) {
        if (!out.anyOf.some((b) => b && b.type === 'null')) out.anyOf = [...out.anyOf, { type: 'null' }];
      } else {
        // Genuinely nothing to fold null into. Dropping nullable silently here
        // would be the exact semantic loss this module exists to prevent.
        warnings.push(`${path}: nullable:true with no \`type\` — null is not expressible, field cannot be null`);
      }
    }
  } else if (node.nullable !== undefined && node.nullable) {
    // Truthy but not literally `true` (`'true'`, `1`). Stripped by the loop
    // above like any other `nullable`, so without this it vanishes with no
    // signal at all — silent loss again, just via a typo instead of a gap.
    warnings.push(`${path}: nullable is ${JSON.stringify(node.nullable)}, not true — treated as absent, field cannot be null`);
  }

  // Strict-mode requirement. Only ever ADDS the key: a schema that already
  // states its own intent keeps it, so this is idempotent and safe to run on an
  // already-converted schema.
  if (isObjectNode(out) && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }

  return out;
}

// Convert a Gemini-dialect response schema into one Anthropic's strict
// validator accepts. Returns a NEW object; the input is never touched.
//
// `warn` (default true) logs anything that could not be translated faithfully.
// The live smoke check (test/live/smoke.js) passes false and reads the
// diagnostics itself.
function toAnthropicSchema(schema, { warn = true } = {}) {
  if (!schema || typeof schema !== 'object') return schema;
  const warnings = [];
  const converted = convert(schema, '$', warnings);
  if (warn && warnings.length) {
    console.warn(`[schema-compat] ${warnings.length} field(s) lost meaning in translation: ${warnings.join('; ')}`);
  }
  return converted;
}

// Same conversion, diagnostics returned instead of logged.
function inspect(schema) {
  const warnings = [];
  const converted = convert(schema, '$', warnings);
  return { schema: converted, warnings };
}

module.exports = { toAnthropicSchema, inspect };
