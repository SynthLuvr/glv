import { describe } from "vitest";
import { runMobileDragSuite } from "../../glv/tests/suites/mobile-drag.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("mobile-drag", () => runMobileDragSuite(claudeFixture));
