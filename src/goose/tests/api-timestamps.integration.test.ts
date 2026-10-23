import { describe } from "vitest";
import { runApiTimestampsSuite } from "../../glv/tests/suites/api-timestamps.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api timestamps", () => runApiTimestampsSuite(gooseFixture));
