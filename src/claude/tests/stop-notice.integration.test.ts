import { describe } from "vitest";
import { runStopNoticeSuite } from "../../glv/tests/suites/stop-notice.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stop notice", () => runStopNoticeSuite(claudeFixture));
