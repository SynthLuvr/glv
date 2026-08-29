import { describe } from "vitest";
import { runAuthFlowsSuite } from "../../glv/tests/suites/auth-flows.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("auth flows", () => runAuthFlowsSuite(gooseFixture));
