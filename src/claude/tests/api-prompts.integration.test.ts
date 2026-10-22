import { describe } from "vitest";
import { runApiPromptsSuite } from "../../glv/tests/suites/api-prompts.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api prompts", () => runApiPromptsSuite(claudeFixture));
