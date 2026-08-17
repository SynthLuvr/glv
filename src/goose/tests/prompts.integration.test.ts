import { describe } from "vitest";
import { runPromptsSuite } from "../../glv/tests/suites/prompts.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("prompts", () => runPromptsSuite(gooseFixture));
