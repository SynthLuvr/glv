import { describe } from "vitest";
import { runErrorResultsSuite } from "../../glv/tests/suites/error-results.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("error results", () => runErrorResultsSuite(gooseFixture));
