import { describe, expect, it } from "vitest";
import { makeClaudeAgent, PERMISSION_MODES } from "../agent.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// --permission-mode overrides permissions.defaultMode in the user's
// ~/.claude/settings.json, so the default must emit no flag at all.
describe("permission mode flags", () => {
  it("emits no --permission-mode for inherit, default or explicit", () => {
    const argSets = [
      makeClaudeAgent("claude").newSession("hi", SESSION_ID),
      makeClaudeAgent("claude").resume(SESSION_ID, "hi"),
      makeClaudeAgent("claude", "inherit").newSession("hi", SESSION_ID),
      makeClaudeAgent("claude", "inherit").resume(SESSION_ID, "hi"),
    ];
    for (const args of argSets) expect(args).not.toContain("--permission-mode");
  });

  it("passes every other mode through, on new and resumed runs", () => {
    const modes = PERMISSION_MODES.filter((mode) => mode !== "inherit");
    const argSets = modes.flatMap((mode) => [
      [
        mode,
        makeClaudeAgent("claude", mode).newSession("hi", SESSION_ID),
      ] as const,
      [mode, makeClaudeAgent("claude", mode).resume(SESSION_ID, "hi")] as const,
    ]);
    for (const [mode, args] of argSets) {
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe(mode);
    }
  });

  it('defaults the agent to "inherit"', () => {
    expect(
      makeClaudeAgent("claude").newSession("hi", SESSION_ID),
    ).not.toContain("--permission-mode");
  });

  it("rejects a mode outside the known list", () => {
    expect(() => makeClaudeAgent("claude", "yolo")).toThrow(
      /Invalid permission mode/,
    );
  });
});
