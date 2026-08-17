import { describe } from "vitest";
import { runRunnerStreamSuite } from "../../glv/tests/suites/runner-stream.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("runner-stream", () => runRunnerStreamSuite(gooseFixture));
