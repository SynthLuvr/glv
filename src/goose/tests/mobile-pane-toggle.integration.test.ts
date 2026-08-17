import { describe } from "vitest";
import { runMobilePaneToggleSuite } from "../../glv/tests/suites/mobile-pane-toggle.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("mobile-pane-toggle", () => runMobilePaneToggleSuite(gooseFixture));
