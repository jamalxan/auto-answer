/**
 * JSON Schema sanitiser for Gemini's OpenAI-compatible endpoint.
 *
 * Gemini accepts only an OpenAPI-like subset of JSON Schema and answers
 * `400 INVALID_ARGUMENT` for the rest (live test B-01: the AI Flow Builder
 * schema carried `additionalProperties`, `pattern`, an integer `enum` and big
 * `maxItems`). `sanitizeSchemaForGemini` returns a deep copy that keeps only
 * keywords Gemini understands; our own parsers still validate the answer.
 *
 * `lossy` is true when removing a keyword changes what the model may emit
 * (free-form objects: `additionalProperties: true`, or an object without
 * declared properties). The provider then skips the schema and asks for plain
 * `json_object` mode, which keeps the extra fields.
 */

export interface SanitizedSchema {
  schema: Record<string, unknown>;
  lossy: boolean;
}

const KEEP = new Set(["type", "properties", "required", "items", "enum", "description", "nullable", "anyOf", "format"]);
const KEEP_FORMATS = new Set(["date-time", "enum"]);
const MAX_DESCRIPTION = 300;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeNode(node: unknown, state: { lossy: boolean }): unknown {
  if (!isObject(node)) return node;
  const source: Record<string, unknown> = { ...node };

  // const -> single-value enum; oneOf -> anyOf
  if ("const" in source && !("enum" in source)) source.enum = [source.const];
  if (Array.isArray(source.oneOf) && !source.anyOf) source.anyOf = source.oneOf;

  if (source.additionalProperties === true) state.lossy = true;
  if ("$ref" in source) state.lossy = true;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KEEP.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === "string");
      const real = types.find((t) => t !== "null");
      if (real) out.type = real;
      if (types.includes("null")) out.nullable = true;
      continue;
    }
    if (key === "properties" && isObject(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeNode(v, state)]));
      continue;
    }
    if (key === "items") {
      out.items = sanitizeNode(value, state);
      continue;
    }
    if (key === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map((v) => sanitizeNode(v, state));
      continue;
    }
    if (key === "enum") {
      // Gemini wants string enums only (an integer enum is a 400).
      if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) out.enum = value;
      else if (source.type === "integer" || source.type === "number") {
        // numeric enums are dropped; the type stays.
      }
      continue;
    }
    if (key === "format") {
      if (typeof value === "string" && KEEP_FORMATS.has(value)) out.format = value;
      continue;
    }
    if (key === "description") {
      if (typeof value === "string") out.description = value.slice(0, MAX_DESCRIPTION);
      continue;
    }
    out[key] = value;
  }

  if (out.type === "object" && (!isObject(out.properties) || Object.keys(out.properties).length === 0)) {
    // Gemini rejects an object with no properties; it is free-form for us.
    state.lossy = true;
  }
  if (Array.isArray(out.required) && isObject(out.properties)) {
    out.required = (out.required as unknown[]).filter((r) => typeof r === "string" && r in (out.properties as object));
    if ((out.required as unknown[]).length === 0) delete out.required;
  }
  return out;
}

export function sanitizeSchemaForGemini(schema: Record<string, unknown>): SanitizedSchema {
  const state = { lossy: false };
  const cleaned = sanitizeNode(schema, state);
  const result = isObject(cleaned) ? cleaned : {};
  // An empty / non-object root is not a usable schema either.
  if (result.type !== "object") state.lossy = true;
  return { schema: result, lossy: state.lossy };
}

/** True when the endpoint / model is Gemini (needs the sanitiser). */
export function isGeminiTarget(baseUrl: string, model: string): boolean {
  return /generativelanguage\.googleapis\.com|googleapis\.com/i.test(baseUrl) || /^(models\/)?gemini/i.test(model);
}
