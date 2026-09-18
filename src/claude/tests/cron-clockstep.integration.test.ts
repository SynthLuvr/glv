import { describe } from "vitest";
import { runCronClockStepSuite } from "../../glv/tests/suites/cron-clockstep.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("cron-clockstep", () => runCronClockStepSuite(claudeFixture));
