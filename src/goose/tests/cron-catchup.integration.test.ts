import { describe } from "vitest";
import { runCronCatchUpSuite } from "../../glv/tests/suites/cron-catchup.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("cron-catchup", () => runCronCatchUpSuite(gooseFixture));
