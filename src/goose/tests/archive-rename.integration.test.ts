import { describe } from "vitest";
import { runArchiveRenameSuite } from "../../glv/tests/suites/archive-rename.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("archive-rename", () => runArchiveRenameSuite(gooseFixture));
