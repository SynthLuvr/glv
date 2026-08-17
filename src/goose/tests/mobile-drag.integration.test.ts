import { describe } from "vitest";
import { runMobileDragSuite } from "../../glv/tests/suites/mobile-drag.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("mobile-drag", () => runMobileDragSuite(gooseFixture));
