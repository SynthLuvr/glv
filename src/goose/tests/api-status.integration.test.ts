import { describe } from "vitest";
import { runApiStatusSuite } from "../../glv/tests/suites/api-status.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api status", () => runApiStatusSuite(gooseFixture));
