import { describe } from "vitest";
import { runScopeSuite } from "../../glv/tests/suites/run-scope.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("run scope", () => runScopeSuite(gooseFixture));
