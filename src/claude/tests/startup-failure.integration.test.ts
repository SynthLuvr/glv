import { describe } from "vitest";
import { runStartupFailureSuite } from "../../glv/tests/suites/startup-failure.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("startup failure", () => runStartupFailureSuite(claudeFixture));
