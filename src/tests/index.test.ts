import { describe, expect, it } from "vitest";

import { greet } from "../index";

describe("greet", () => {
  it("returns a greeting", () => {
    expect(greet()).toBe("hello");
  });
});
