import { describe } from "vitest";
import { runNewSessionNavSuite } from "../../glv/tests/suites/new-session-nav.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("new session navigation", () => runNewSessionNavSuite(claudeFixture));
