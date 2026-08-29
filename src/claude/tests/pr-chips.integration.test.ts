import { describe } from "vitest";
import { runPrChipsSuite } from "../../glv/tests/suites/pr-chips.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("pr-chips", () => runPrChipsSuite(claudeFixture));
