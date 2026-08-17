import { describe } from "vitest";
import { runAuthSuite } from "../../glv/tests/suites/auth.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("auth", () => runAuthSuite(claudeFixture));
