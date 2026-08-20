import { describe } from "vitest";
import { runStopEscalationSuite } from "../../glv/tests/suites/stop-escalation.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stop-escalation", () => runStopEscalationSuite(claudeFixture));
