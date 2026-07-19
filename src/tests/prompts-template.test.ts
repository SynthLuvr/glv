import { describe, expect, it } from "vitest";
import {
  findUnknownPlaceholders,
  substitutePlaceholders,
} from "../prompts/template.js";

describe("substitutePlaceholders", () => {
  it("replaces placeholders present in the values map", () => {
    const out = substitutePlaceholders(
      "Work in {{working_dir}} on {{branch}}",
      { working_dir: "/tmp/x", branch: "main" },
    );
    expect(out).toBe("Work in /tmp/x on main");
  });

  it("leaves placeholders absent from values untouched", () => {
    expect(substitutePlaceholders("{{repo}} here", { working_dir: "/x" })).toBe(
      "{{repo}} here",
    );
  });

  it("replaces a present-but-empty value with an empty string", () => {
    expect(substitutePlaceholders("[{{repo}}]", { repo: "" })).toBe("[]");
  });

  it("replaces every occurrence", () => {
    expect(
      substitutePlaceholders("{{date}} and {{date}}", { date: "2026-01-02" }),
    ).toBe("2026-01-02 and 2026-01-02");
  });

  it("ignores single braces and bare text", () => {
    expect(substitutePlaceholders("a {b} c", { b: "x" })).toBe("a {b} c");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(substitutePlaceholders("{{  date  }}", { date: "D" })).toBe("D");
  });
});

describe("findUnknownPlaceholders", () => {
  it("returns names that are neither known nor supplied", () => {
    expect(
      findUnknownPlaceholders("{{topic}} {{count}}", { count: "1" }),
    ).toEqual(["topic"]);
  });

  it("excludes the built-in known placeholders", () => {
    expect(findUnknownPlaceholders("{{working_dir}} {{branch}}", {})).toEqual(
      [],
    );
  });

  it("excludes names supplied in values", () => {
    expect(findUnknownPlaceholders("{{x}}", { x: "1" })).toEqual([]);
  });

  it("is distinct and preserves first-appearance order", () => {
    expect(findUnknownPlaceholders("{{b}} {{a}} {{b}}", {})).toEqual([
      "b",
      "a",
    ]);
  });

  it("returns nothing for placeholder-free or known-only text", () => {
    expect(findUnknownPlaceholders("plain text {{date}}", {})).toEqual([]);
  });
});
