// MCP inputSchema → a JSON Schema subset every provider accepts.
//
// MCP servers emit full JSON Schema (often generated from zod / pydantic, with
// $defs + $ref, type arrays, const, oneOf, formats…). Gemini's function
// declarations in particular reject most of that. We normalise to the common
// subset: object/array/string/number/integer/boolean with properties,
// required, items, enum, description, anyOf, nullable-free single types.

const MAX_DEPTH = 12;

// Keys dropped outright — metadata or constructs some provider rejects.
const DROP_KEYS = new Set([
  "$schema", "$id", "$comment", "$anchor", "$dynamicAnchor", "$dynamicRef",
  "$defs", "definitions", "examples", "readOnly", "writeOnly", "deprecated",
  "contentMediaType", "contentEncoding", "if", "then", "else", "not",
  "patternProperties", "unevaluatedProperties", "unevaluatedItems",
  "dependentSchemas", "dependentRequired", "propertyNames", "additionalItems",
  "prefixItems", "contains", "minContains", "maxContains", "title", "default",
]);

// Gemini only accepts these string formats.
const KEEP_FORMATS = new Set(["date-time", "enum"]);

type Schema = Record<string, unknown>;

function isObj(v: unknown): v is Schema {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function resolveRef(ref: string, root: Schema): Schema | undefined {
  const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) return undefined;
  const defs = root[m[1]];
  const name = m[2].replace(/~1/g, "/").replace(/~0/g, "~");
  return isObj(defs) && isObj(defs[name]) ? (defs[name] as Schema) : undefined;
}

function clean(node: unknown, root: Schema, depth: number, refStack: string[]): Schema {
  if (!isObj(node) || depth > MAX_DEPTH) return {};

  if (typeof node.$ref === "string") {
    if (refStack.includes(node.$ref)) return {}; // recursive type — cut the cycle
    const target = resolveRef(node.$ref, root);
    const merged = target ? { ...target, ...withoutKey(node, "$ref") } : withoutKey(node, "$ref");
    return clean(merged, root, depth + 1, [...refStack, node.$ref]);
  }

  // allOf: shallow-merge object members (the common zod/pydantic output).
  if (Array.isArray(node.allOf)) {
    let merged: Schema = withoutKey(node, "allOf");
    for (const part of node.allOf) {
      const c = clean(part, root, depth + 1, refStack);
      merged = {
        ...c,
        ...merged,
        properties: { ...(isObj(c.properties) ? c.properties : {}), ...(isObj(merged.properties) ? merged.properties : {}) },
        required: [...asStrings(c.required), ...asStrings(merged.required)],
      };
    }
    if (Object.keys(merged.properties as Schema).length === 0) delete merged.properties;
    if ((merged.required as string[]).length === 0) delete merged.required;
    return clean(merged, root, depth + 1, refStack);
  }

  const out: Schema = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP_KEYS.has(k)) continue;
    switch (k) {
      case "type": {
        if (Array.isArray(v)) {
          const nonNull = v.filter((t) => t !== "null");
          if (nonNull.length > 0) out.type = nonNull[0];
        } else if (typeof v === "string" && v !== "null") {
          out.type = v;
        }
        break;
      }
      case "const":
        out.enum = [v];
        break;
      case "enum":
        if (Array.isArray(v)) {
          const vals = v.filter((x) => x !== null);
          if (vals.length > 0) out.enum = vals;
        }
        break;
      case "format":
        if (typeof v === "string" && KEEP_FORMATS.has(v)) out.format = v;
        break;
      case "properties":
        if (isObj(v)) {
          const props: Schema = {};
          for (const [pk, pv] of Object.entries(v)) props[pk] = clean(pv, root, depth + 1, refStack);
          out.properties = props;
        }
        break;
      case "items":
        out.items = Array.isArray(v) ? clean(v[0], root, depth + 1, refStack) : clean(v, root, depth + 1, refStack);
        break;
      case "anyOf":
      case "oneOf": {
        if (!Array.isArray(v)) break;
        const opts = v
          .filter((o) => !(isObj(o) && o.type === "null"))
          .map((o) => clean(o, root, depth + 1, refStack));
        // `X | null` collapses to X.
        if (opts.length === 1) Object.assign(out, opts[0]);
        else if (opts.length > 1) out.anyOf = opts;
        break;
      }
      case "additionalProperties":
        // Only a boolean is safe across providers; a schema-valued one is dropped.
        if (typeof v === "boolean") out.additionalProperties = v;
        break;
      default:
        out[k] = v;
    }
  }

  // Infer a missing type where it is unambiguous.
  if (out.type === undefined && !out.anyOf) {
    if (out.properties) out.type = "object";
    else if (out.items) out.type = "array";
  }
  if (out.type === "array" && !out.items) out.items = {};
  if (Array.isArray(out.required)) {
    const props = isObj(out.properties) ? out.properties : {};
    const req = asStrings(out.required).filter((r) => r in props);
    if (req.length > 0) out.required = Array.from(new Set(req));
    else delete out.required;
  }
  return out;
}

function withoutKey(o: Schema, key: string): Schema {
  const { [key]: _drop, ...rest } = o;
  return rest;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Always returns a top-level `{type:"object", properties:{…}}` schema. */
export function sanitizeInputSchema(schema: unknown): Record<string, unknown> {
  const root = isObj(schema) ? schema : {};
  const cleaned = clean(root, root, 0, []);
  return {
    ...cleaned,
    type: "object",
    properties: isObj(cleaned.properties) ? cleaned.properties : {},
  };
}
