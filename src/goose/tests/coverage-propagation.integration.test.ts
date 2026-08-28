import { describe } from "vitest";
import { runCoveragePropagationSuite } from "../../glv/tests/suites/coverage-propagation.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("coverage propagation", () =>
  runCoveragePropagationSuite(gooseFixture));
