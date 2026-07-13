import { describe, expect, it } from "vitest";
import * as mod from "../index.js";

describe("index module", () => {
  it("exports db helpers", () => {
    expect(typeof mod.listSessions).toBe("function");
    expect(typeof mod.getSession).toBe("function");
  });

  it("exports format helpers", () => {
    expect(typeof mod.parseContent).toBe("function");
    expect(typeof mod.renderTable).toBe("function");
  });
});
