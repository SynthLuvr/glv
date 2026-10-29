import { describe } from "vitest";
import { runPitchSuite } from "../../glv/tests/suites/pitch.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("pitch", () => runPitchSuite(claudeFixture));
