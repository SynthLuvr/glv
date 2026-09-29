import { describe } from "vitest";
import { runApiTokensSuite } from "../../glv/tests/suites/api-tokens.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api tokens", () => runApiTokensSuite(claudeFixture));
