import { describe } from "vitest";
import { runErrorResultsSuite } from "../../glv/tests/suites/error-results.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("error results", () => runErrorResultsSuite(claudeFixture));
