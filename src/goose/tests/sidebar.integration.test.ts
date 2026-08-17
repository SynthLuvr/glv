import { describe } from "vitest";
import { runSidebarSuite } from "../../glv/tests/suites/sidebar.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("sidebar", () => runSidebarSuite(gooseFixture));
