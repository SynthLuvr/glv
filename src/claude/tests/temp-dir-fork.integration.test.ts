import { describe } from "vitest";
import { runTempDirForkSuite } from "../../glv/tests/suites/temp-dir-fork.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("temp-dir-fork", () => runTempDirForkSuite(claudeFixture));
