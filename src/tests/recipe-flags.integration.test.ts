import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  type IntegrationEnv,
  startIntegrationEnv,
  withPage,
} from "./integration-harness";

// Exercises the real GLV → goose spawn path over HTTP/SSE and asserts that a
// NEW session is launched with the GLV Default Profile recipe translated into
// `goose run` flags (provider, model, extensions, standing instructions),
// while the prompt still flows through stdin (`-i -`). The goose binary is the
// mock script, which captures its argv to a file so the test can read it back.
const SESSION_NAME = "Recipe Flag Test";
const PROMPT_TEXT = "Summarize the repo in one sentence.";

let env: IntegrationEnv;
let workDir: string;
let argsPath: string;
let argsDir: string;

beforeAll(async () => {
  // captureArgs must be resolvable before the server boots (the scratch dir is
  // created inside startIntegrationEnv), so it lives in its own temp dir.
  argsDir = mkdtempSync(join(tmpdir(), "glv-recipe-args-"));
  argsPath = join(argsDir, "argv.json");

  env = await startIntegrationEnv("glv-recipe-", {
    sessionName: SESSION_NAME,
    captureArgs: argsPath,
  });

  workDir = join(env.scratchDir, "project");
  mkdirSync(workDir, { recursive: true });
}, 90000);

afterAll(async () => {
  await env?.cleanup();
  rmSync(argsDir, { recursive: true, force: true });
});

// The mock writes argv as soon as it is spawned; poll briefly in case the test
// reads before the child has flushed the file.
const readCapturedArgs = async (timeoutMs = 5000): Promise<string[]> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(argsPath))
      return JSON.parse(readFileSync(argsPath, "utf-8")) as string[];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`mock argv was not captured at ${argsPath}`);
};

const valueAfter = (argv: string[], flag: string): string =>
  argv[argv.indexOf(flag) + 1];

describe("new session — recipe-derived flags", () => {
  it("starts a session and the mock receives the recipe flags", async () => {
    await withPage(env.context, async (page) => {
      await page.goto(env.baseUrl);
      await page.locator("form.new-session-form").waitFor();

      await page.locator('input[name="working_dir"]').fill(workDir);
      await page.locator('textarea[name="prompt"]').fill(PROMPT_TEXT);
      await page.locator("button.send-btn").click();

      // Wait until GLV has re-keyed the run onto the real session id.
      await page
        .locator("button.archive-btn")
        .waitFor({ state: "visible", timeout: 20000 });
    });

    const argv = await readCapturedArgs();

    // Agent config from the recipe's `agent:` block.
    expect(valueAfter(argv, "--provider")).toBe("zai");
    expect(valueAfter(argv, "--model")).toBe("glm-5.2");

    // The recipe defines a complete extension set, so the default profile is
    // replaced rather than merged.
    expect(argv).toContain("--no-profile");

    // Standing instructions (recipe `instructions`) reach goose via --system.
    expect(valueAfter(argv, "--system")).toBe("Carry out the user's request.");

    // Every stdio extension becomes its own --with-extension, with the complex
    // bash-script commands (shell-quoted) surviving intact.
    const stdioExts = argv.filter((_, i) => argv[i - 1] === "--with-extension");
    expect(stdioExts).toHaveLength(4);
    expect(
      stdioExts.some(
        (e) => e.includes("githubcopilot") && e.includes("$(gh auth token)"),
      ),
    ).toBe(true);
    expect(stdioExts.some((e) => e.includes("linux-mcp-server"))).toBe(true);
    expect(stdioExts.some((e) => e.includes("block.gitmcp.io"))).toBe(true);
    expect(stdioExts.some((e) => e.includes("tavily-mcp"))).toBe(true);

    // Bundled platform/builtin extensions collapse into one --with-builtin.
    const builtinNames = valueAfter(argv, "--with-builtin").split(",");
    const expectedBuiltins = [
      "extensionmanager",
      "summon",
      "analyze",
      "code_execution",
      "skills",
      "chatrecall",
      "summarize",
      "developer",
      "todo",
      "orchestrator",
    ];
    for (const name of expectedBuiltins) expect(builtinNames).toContain(name);

    // The prompt still travels through stdin (`-i -`), never via --recipe,
    // --text, or a resume flag — this is a brand-new session.
    expect(argv).toContain("-i");
    expect(argv).toContain("-");
    expect(argv).not.toContain("--recipe");
    expect(argv).not.toContain("-r");
    expect(argv).not.toContain("--session-id");
  });
}, 60000);
