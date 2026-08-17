import { describe } from "vitest";
import { runStopKillsDescendantsSuite } from "../../glv/tests/suites/stop-kills-descendants.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stop-kills-descendants", () =>
  runStopKillsDescendantsSuite(claudeFixture));
