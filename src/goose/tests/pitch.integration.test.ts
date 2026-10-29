import { describe } from "vitest";
import { runPitchSuite } from "../../glv/tests/suites/pitch.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("pitch", () => runPitchSuite(gooseFixture));
