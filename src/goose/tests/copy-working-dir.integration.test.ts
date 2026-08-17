import { describe } from "vitest";
import { runCopyWorkingDirSuite } from "../../glv/tests/suites/copy-working-dir.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("copy-working-dir", () => runCopyWorkingDirSuite(gooseFixture));
