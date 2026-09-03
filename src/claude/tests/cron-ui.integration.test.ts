import { describe } from "vitest";
import { runCronUiSuite } from "../../glv/tests/suites/cron-ui.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("cron ui", () => runCronUiSuite(claudeFixture));
