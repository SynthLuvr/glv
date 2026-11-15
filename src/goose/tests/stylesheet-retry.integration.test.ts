import { describe } from "vitest";
import { runStylesheetRetrySuite } from "../../glv/tests/suites/stylesheet-retry.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stylesheet retry", () => runStylesheetRetrySuite(gooseFixture));
