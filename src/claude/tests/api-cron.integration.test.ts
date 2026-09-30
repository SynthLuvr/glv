import { describe } from "vitest";
import { runApiCronSuite } from "../../glv/tests/suites/api-cron.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api cron", () => runApiCronSuite(claudeFixture));
