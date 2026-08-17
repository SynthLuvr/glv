import { describe } from "vitest";
import { runSidebarSuite } from "../../glv/tests/suites/sidebar.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("sidebar", () => runSidebarSuite(claudeFixture));
