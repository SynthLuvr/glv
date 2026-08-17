import { describe } from "vitest";
import { runStreamLiveSuite } from "../../glv/tests/suites/stream-live.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stream-live", () => runStreamLiveSuite(gooseFixture));
