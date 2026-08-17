import { describe } from "vitest";
import { runRunnerStreamSuite } from "../../glv/tests/suites/runner-stream.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("runner-stream", () => runRunnerStreamSuite(claudeFixture));
