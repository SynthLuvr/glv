import { describe } from "vitest";
import { runApiLastRunSuite } from "../../glv/tests/suites/api-last-run.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api last run", () => runApiLastRunSuite(claudeFixture));
