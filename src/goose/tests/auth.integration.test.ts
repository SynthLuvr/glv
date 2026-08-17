import { describe } from "vitest";
import { runAuthSuite } from "../../glv/tests/suites/auth.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("auth", () => runAuthSuite(gooseFixture));
