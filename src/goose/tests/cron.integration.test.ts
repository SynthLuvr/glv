import { describe } from "vitest";
import { runCronSuite } from "../../glv/tests/suites/cron.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("cron", () => runCronSuite(gooseFixture));
