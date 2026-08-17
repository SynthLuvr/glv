import { describe } from "vitest";
import { runStructuredLoggerSuite } from "../../glv/tests/suites/structured-logger.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("structured-logger", () => runStructuredLoggerSuite(claudeFixture));
