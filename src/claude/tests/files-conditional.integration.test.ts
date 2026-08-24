import { describe } from "vitest";
import { runFilesConditionalSuite } from "../../glv/tests/suites/files-conditional.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("files conditional", () => runFilesConditionalSuite(claudeFixture));
