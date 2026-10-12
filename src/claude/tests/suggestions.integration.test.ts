import { describe } from "vitest";
import { runSuggestionsSuite } from "../../glv/tests/suites/suggestions.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("suggestions", () => runSuggestionsSuite(claudeFixture));
