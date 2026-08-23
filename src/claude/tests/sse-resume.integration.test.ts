import { describe } from "vitest";
import { runSseResumeSuite } from "../../glv/tests/suites/sse-resume.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("sse-resume", () => runSseResumeSuite(claudeFixture));
