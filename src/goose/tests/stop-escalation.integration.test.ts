import { describe } from "vitest";
import { runStopEscalationSuite } from "../../glv/tests/suites/stop-escalation.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stop-escalation", () => runStopEscalationSuite(gooseFixture));
