import { describe } from "vitest";
import { runStylesheetRetrySuite } from "../../glv/tests/suites/stylesheet-retry.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stylesheet retry", () => runStylesheetRetrySuite(claudeFixture));
