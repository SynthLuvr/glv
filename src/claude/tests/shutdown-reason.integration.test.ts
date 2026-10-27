import { describe } from "vitest";
import { runShutdownReasonSuite } from "../../glv/tests/suites/shutdown-reason.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("shutdown-reason", () => runShutdownReasonSuite(claudeFixture));
