import { describe } from "vitest";
import { runUiFixesSuite } from "../../glv/tests/suites/ui-fixes.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("ui-fixes", () => runUiFixesSuite(claudeFixture));
