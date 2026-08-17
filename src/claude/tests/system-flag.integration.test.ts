import { describe } from "vitest";
import { runSystemFlagSuite } from "../../glv/tests/suites/system-flag.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("system-flag", () => runSystemFlagSuite(claudeFixture));
