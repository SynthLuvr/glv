import { describe } from "vitest";
import { runTempDirSuite } from "../../glv/tests/suites/temp-dir.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("temp-dir", () => runTempDirSuite(gooseFixture));
