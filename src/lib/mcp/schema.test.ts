import { describe, expect, it } from "vitest";
import { sanitizeInputSchema } from "./schema";

describe("sanitizeInputSchema", () => {
  it("missing / non-object schema → empty object schema", () => {
    expect(sanitizeInputSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(sanitizeInputSchema("nope")).toEqual({ type: "object", properties: {} });
  });

  it("drops $schema / title / default / examples and unsupported formats", () => {
    const out = sanitizeInputSchema({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      title: "Args",
      properties: {
        id: { type: "string", format: "uuid", default: "x", examples: ["a"], description: "Doc id" },
        when: { type: "string", format: "date-time" },
      },
      required: ["id"],
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: "Doc id" },
        when: { type: "string", format: "date-time" },
      },
      required: ["id"],
    });
  });

  it("inlines $defs/$ref and cuts recursive refs", () => {
    const out = sanitizeInputSchema({
      type: "object",
      $defs: {
        Op: { type: "object", properties: { index: { type: "integer" }, next: { $ref: "#/$defs/Op" } } },
      },
      properties: { op: { $ref: "#/$defs/Op" } },
    });
    expect(out).toEqual({
      type: "object",
      properties: {
        op: { type: "object", properties: { index: { type: "integer" }, next: {} } },
      },
    });
    expect(JSON.stringify(out)).not.toContain("$ref");
  });

  it("type arrays and `X | null` unions collapse to one type; const → enum", () => {
    const out = sanitizeInputSchema({
      type: "object",
      properties: {
        a: { type: ["string", "null"] },
        b: { anyOf: [{ type: "integer" }, { type: "null" }] },
        c: { const: "after" },
        d: { oneOf: [{ type: "string" }, { type: "integer" }] },
      },
    });
    expect(out.properties).toEqual({
      a: { type: "string" },
      b: { type: "integer" },
      c: { enum: ["after"] },
      d: { anyOf: [{ type: "string" }, { type: "integer" }] },
    });
  });

  it("merges allOf objects and drops required entries that don't exist", () => {
    const out = sanitizeInputSchema({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b", "ghost"] },
      ],
    });
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect((out.required as string[]).sort()).toEqual(["a", "b"]);
  });

  it("keeps boolean additionalProperties, drops schema-valued ones; arrays always get items", () => {
    const out = sanitizeInputSchema({
      type: "object",
      additionalProperties: false,
      properties: { m: { type: "object", additionalProperties: { type: "string" } }, list: { type: "array" } },
    });
    expect(out.additionalProperties).toBe(false);
    expect((out.properties as Record<string, unknown>).m).toEqual({ type: "object" });
    expect((out.properties as Record<string, unknown>).list).toEqual({ type: "array", items: {} });
  });
});
