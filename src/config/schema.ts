// The runtime check of schema/qlander.schema.json (docs/deployment.md
// §1.4). The tick has no dependencies (DESIGN.md §12.2), so this interprets
// the schema file itself instead of a library: the subset of JSON Schema
// 2020-12 the schema uses, and nothing else. A keyword it does not implement
// is a thrown error, never ignored, so the schema cannot grow a rule this
// check silently skips. test/config-validation.test.ts runs a corpus through
// this and ajv and requires the same verdict for each.

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "$comment", "$defs"]);
const KEYWORDS = new Set(["$ref", "type", "const", "enum", "oneOf", "minLength", "pattern", "minimum", "minItems", "items", "required", "properties", "additionalProperties"]);

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function typeOk(type: unknown, v: unknown): boolean {
  switch (type) {
    case "object":
      return isObj(v);
    case "array":
      return Array.isArray(v);
    case "string":
      return typeof v === "string";
    case "boolean":
      return typeof v === "boolean";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    default:
      throw new Error(`schema type ${JSON.stringify(type)} is not supported`);
  }
}

function resolve(root: Schema, ref: unknown): Schema {
  const m = typeof ref === "string" ? /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref) : null;
  const defs = root.$defs;
  const target = m && isObj(defs) ? defs[m[1]!] : undefined;
  if (!isObj(target)) throw new Error(`schema $ref ${JSON.stringify(ref)} does not resolve`);
  return target;
}

function check(root: Schema, s: Schema, v: unknown, at: string, out: string[]): void {
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k) && !ANNOTATIONS.has(k)) throw new Error(`schema keyword ${k} is not supported`);
  if (s.$ref !== undefined) check(root, resolve(root, s.$ref), v, at, out);
  if (s.type !== undefined && !typeOk(s.type, v)) {
    out.push(`${at}: must be ${s.type === "object" ? "a mapping" : s.type === "array" ? "a list" : `a(n) ${s.type}`}`);
    return;
  }
  if ("const" in s && !Bun.deepEquals(v, s.const, true)) out.push(`${at}: must be ${JSON.stringify(s.const)}`);
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => Bun.deepEquals(v, e, true))) out.push(`${at}: must be one of ${JSON.stringify(s.enum)}`);
  if (s.oneOf !== undefined) {
    const results = (s.oneOf as Schema[]).map((sub) => {
      const p: string[] = [];
      check(root, sub, v, at, p);
      return p;
    });
    const matched = results.filter((p) => p.length === 0).length;
    if (matched !== 1) {
      const closest = results.reduce((a, b) => (b.length < a.length ? b : a));
      out.push(matched === 0 ? `${at}: matches none of the allowed forms (closest: ${closest.join("; ")})` : `${at}: matches more than one form`);
    }
  }
  if (typeof v === "string") {
    if (s.minLength !== undefined && [...v].length < (s.minLength as number)) out.push(`${at}: must not be empty`);
    if (s.pattern !== undefined && !new RegExp(s.pattern as string, "u").test(v)) out.push(`${at}: must match ${s.pattern}`);
  }
  if (typeof v === "number" && s.minimum !== undefined && v < (s.minimum as number)) out.push(`${at}: must be at least ${s.minimum}`);
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < (s.minItems as number)) out.push(`${at}: needs at least ${s.minItems} item(s)`);
    if (s.items !== undefined) v.forEach((x, i) => check(root, s.items as Schema, x, `${at}[${i}]`, out));
  }
  if (isObj(v)) {
    for (const r of (s.required as string[] | undefined) ?? []) if (!Object.hasOwn(v, r)) out.push(`${at}: missing ${r}`);
    const props = (s.properties as Record<string, Schema> | undefined) ?? {};
    for (const [k, x] of Object.entries(v)) {
      const where = `${at}.${k}`;
      if (Object.hasOwn(props, k)) check(root, props[k]!, x, where, out);
      else if (s.additionalProperties === false) out.push(`${where}: unknown key`);
      else if (isObj(s.additionalProperties)) check(root, s.additionalProperties, x, where, out);
    }
  }
}

/** Every way `value` breaks `schema`, as "path: problem" lines; empty when it conforms. */
export function schemaProblems(schema: Schema, value: unknown): string[] {
  const out: string[] = [];
  check(schema, schema, value, "$", out);
  return out;
}
