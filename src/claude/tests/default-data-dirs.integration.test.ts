import { describe } from "vitest";
import { runDefaultDataDirsSuite } from "../../glv/tests/suites/default-data-dirs.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("default-data-dirs", () => runDefaultDataDirsSuite(claudeFixture));
