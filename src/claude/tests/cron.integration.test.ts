import { describe } from "vitest";
import { runCronSuite } from "../../glv/tests/suites/cron.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("cron", () => runCronSuite(claudeFixture));
