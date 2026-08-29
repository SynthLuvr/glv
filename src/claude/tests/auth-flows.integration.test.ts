import { describe } from "vitest";
import { runAuthFlowsSuite } from "../../glv/tests/suites/auth-flows.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("auth flows", () => runAuthFlowsSuite(claudeFixture));
