import { describe } from "vitest";
import { runNewSessionNavSuite } from "../../glv/tests/suites/new-session-nav.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("new session navigation", () => runNewSessionNavSuite(gooseFixture));
