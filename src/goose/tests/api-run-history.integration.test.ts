import { describe } from "vitest";
import { runApiRunHistorySuite } from "../../glv/tests/suites/api-run-history.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api run history", () => runApiRunHistorySuite(gooseFixture));
