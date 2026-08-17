import { describe } from "vitest";
import { runMobileLayoutSuite } from "../../glv/tests/suites/mobile-layout.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("mobile-layout", () => runMobileLayoutSuite(claudeFixture));
