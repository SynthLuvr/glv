import { describe } from "vitest";
import { runArchiveStopsRunSuite } from "../../glv/tests/suites/archive-stops-run.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("archive-stops-run", () => runArchiveStopsRunSuite(claudeFixture));
