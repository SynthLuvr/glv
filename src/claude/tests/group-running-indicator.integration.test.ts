import { describe } from "vitest";
import { runGroupRunningIndicatorSuite } from "../../glv/tests/suites/group-running-indicator.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("group-running-indicator", () =>
  runGroupRunningIndicatorSuite(claudeFixture));
