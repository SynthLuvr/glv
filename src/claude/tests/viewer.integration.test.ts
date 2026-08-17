import { describe } from "vitest";
import { runViewerSuite } from "../../glv/tests/suites/viewer.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("viewer", () => runViewerSuite(claudeFixture));
