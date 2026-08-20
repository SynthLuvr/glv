import { describe } from "vitest";
import { runOobSwapStateSuite } from "../../glv/tests/suites/oob-swap-state.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("oob-swap-state", () => runOobSwapStateSuite(claudeFixture));
