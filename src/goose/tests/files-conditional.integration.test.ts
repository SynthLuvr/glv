import { describe } from "vitest";
import { runFilesConditionalSuite } from "../../glv/tests/suites/files-conditional.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("files conditional", () => runFilesConditionalSuite(gooseFixture));
