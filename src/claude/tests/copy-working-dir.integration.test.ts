import { describe } from "vitest";
import { runCopyWorkingDirSuite } from "../../glv/tests/suites/copy-working-dir.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("copy-working-dir", () => runCopyWorkingDirSuite(claudeFixture));
