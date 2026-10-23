import { describe } from "vitest";
import { runApiTimestampsSuite } from "../../glv/tests/suites/api-timestamps.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api timestamps", () => runApiTimestampsSuite(claudeFixture));
