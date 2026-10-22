import { describe } from "vitest";
import { runApiDetailWindowSuite } from "../../glv/tests/suites/api-detail-window.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api detail window", () => runApiDetailWindowSuite(claudeFixture));
