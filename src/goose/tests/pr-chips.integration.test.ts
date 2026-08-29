import { describe } from "vitest";
import { runPrChipsSuite } from "../../glv/tests/suites/pr-chips.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("pr-chips", () => runPrChipsSuite(gooseFixture));
