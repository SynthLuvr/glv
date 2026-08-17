import { describe } from "vitest";
import { runStreamDiscardSuite } from "../../glv/tests/suites/stream-discard-non-json.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stream-discard-non-json", () => runStreamDiscardSuite(gooseFixture));
