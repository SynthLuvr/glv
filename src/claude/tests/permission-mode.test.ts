import { describe, expect, it } from "vitest";
import {
  makeRunnerConfig,
  newSessionInvocation,
  PERMISSION_MODES,
  resumeInvocation,
} from "../runner/index.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// --permission-mode overrides permissions.defaultMode in the user's
// ~/.claude/settings.json, so the default must emit no flag at all.
describe("permission mode flags", () => {
  it("emits no --permission-mode for inherit, default or explicit", () => {
    const argSets = [
      newSessionInvocation("hi", SESSION_ID).args,
      resumeInvocation(SESSION_ID, "hi").args,
      newSessionInvocation("hi", SESSION_ID, "inherit").args,
      resumeInvocation(SESSION_ID, "hi", "inherit").args,
    ];
    for (const args of argSets) expect(args).not.toContain("--permission-mode");
  });

  it("passes every other mode through, on new and resumed runs", () => {
    const modes = PERMISSION_MODES.filter((mode) => mode !== "inherit");
    const argSets = modes.flatMap((mode) => [
      [mode, newSessionInvocation("hi", SESSION_ID, mode).args] as const,
      [mode, resumeInvocation(SESSION_ID, "hi", mode).args] as const,
    ]);
    for (const [mode, args] of argSets) {
      expect(args).toContain("--permission-mode");
      expect(args[args.indexOf("--permission-mode") + 1]).toBe(mode);
    }
  });

  it('defaults the runner config to "inherit"', () => {
    expect(makeRunnerConfig(6, "claude").permissionMode).toBe("inherit");
  });

  it("rejects a mode outside the known list", () => {
    expect(() => makeRunnerConfig(6, "claude", "yolo")).toThrow(
      /Invalid permission mode/,
    );
  });
});
