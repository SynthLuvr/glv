import { describe } from "vitest";
import { runUiFixesSuite } from "../../glv/tests/suites/ui-fixes.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("ui-fixes", () => runUiFixesSuite(gooseFixture));
