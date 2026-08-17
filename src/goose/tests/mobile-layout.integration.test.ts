import { describe } from "vitest";
import { runMobileLayoutSuite } from "../../glv/tests/suites/mobile-layout.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("mobile-layout", () => runMobileLayoutSuite(gooseFixture));
