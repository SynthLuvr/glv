import { describe } from "vitest";
import { runApiWaitSuite } from "../../glv/tests/suites/api-wait.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api wait", () => runApiWaitSuite(claudeFixture));
