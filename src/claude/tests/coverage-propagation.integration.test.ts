import { describe } from "vitest";
import { runCoveragePropagationSuite } from "../../glv/tests/suites/coverage-propagation.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("coverage propagation", () =>
  runCoveragePropagationSuite(claudeFixture));
