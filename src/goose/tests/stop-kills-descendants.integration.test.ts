import { describe } from "vitest";
import { runStopKillsDescendantsSuite } from "../../glv/tests/suites/stop-kills-descendants.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stop-kills-descendants", () =>
  runStopKillsDescendantsSuite(gooseFixture));
