import type { JsonSchema } from "../types.js";

type Prop = {
  type?: string | string[];
  enum?: unknown[];
  items?: Prop;
  maxItems?: number;
  minItems?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};

function typeOk(v: unknown, t: string): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null":
      return v === null;
    default:
      return true;
  }
}

function checkValue(path: string, v: unknown, p: Prop): string | null {
  if (p.type !== undefined) {
    const types = Array.isArray(p.type) ? p.type : [p.type];
    if (!types.some((t) => typeOk(v, t))) return `${path} must be ${types.join(" or ")}`;
  }
  if (p.enum && !p.enum.includes(v)) return `${path} must be one of ${p.enum.map(String).join(", ")}`;
  if (typeof v === "string" && p.maxLength !== undefined && v.length > p.maxLength) return `${path} is longer than ${p.maxLength} characters`;
  if (typeof v === "number") {
    if (p.minimum !== undefined && v < p.minimum) return `${path} must be at least ${p.minimum}`;
    if (p.maximum !== undefined && v > p.maximum) return `${path} must be at most ${p.maximum}`;
  }
  if (Array.isArray(v)) {
    if (p.maxItems !== undefined && v.length > p.maxItems) return `${path} has more than ${p.maxItems} items`;
    if (p.minItems !== undefined && v.length < p.minItems) return `${path} needs at least ${p.minItems} items`;
    if (p.items) {
      for (let i = 0; i < v.length; i++) {
        const e = checkValue(`${path}[${i}]`, v[i], p.items);
        if (e) return e;
      }
    }
  }
  return null;
}

/** Validate tool arguments against the tool's advertised input schema (the subset our schemas use). */
export function validateArgs(args: Record<string, unknown>, schema: JsonSchema): string | null {
  for (const r of schema.required ?? []) {
    if (args[r] === undefined || args[r] === null) return `${r} is required`;
  }
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k] as Prop | undefined;
    if (!p) {
      if (schema.additionalProperties === false) return `unknown argument ${JSON.stringify(k.slice(0, 40))}; allowed: ${Object.keys(schema.properties).join(", ")}`;
      continue;
    }
    if (v === undefined || v === null) continue; // optional and absent
    const e = checkValue(k, v, p);
    if (e) return e;
  }
  return null;
}
