import { describe } from "vitest";
import { runApiCronSuite } from "../../glv/tests/suites/api-cron.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api cron", () => runApiCronSuite(gooseFixture));
