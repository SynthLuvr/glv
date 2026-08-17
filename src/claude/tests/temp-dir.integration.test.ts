import { describe } from "vitest";
import { runTempDirSuite } from "../../glv/tests/suites/temp-dir.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("temp-dir", () => runTempDirSuite(claudeFixture));
