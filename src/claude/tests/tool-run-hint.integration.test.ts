import { describe } from "vitest";
import { runToolRunHintSuite } from "../../glv/tests/suites/tool-run-hint.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("tool run hint", () => runToolRunHintSuite(claudeFixture));
