import { describe } from "vitest";
import { runStreamLiveSuite } from "../../glv/tests/suites/stream-live.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stream-live", () => runStreamLiveSuite(claudeFixture));
