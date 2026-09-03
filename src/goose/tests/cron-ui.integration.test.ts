import { describe } from "vitest";
import { runCronUiSuite } from "../../glv/tests/suites/cron-ui.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("cron ui", () => runCronUiSuite(gooseFixture));
