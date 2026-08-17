import { describe } from "vitest";
import { runScrollPromptBarSuite } from "../../glv/tests/suites/scroll-prompt-bar.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("scroll-prompt-bar", () => runScrollPromptBarSuite(claudeFixture));
