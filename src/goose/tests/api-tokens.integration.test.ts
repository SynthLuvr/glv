import { describe } from "vitest";
import { runApiTokensSuite } from "../../glv/tests/suites/api-tokens.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api tokens", () => runApiTokensSuite(gooseFixture));
