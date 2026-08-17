import { describe } from "vitest";
import { runCookieIsolationSuite } from "../../glv/tests/suites/cookie-isolation.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("cookie-isolation", () => runCookieIsolationSuite(claudeFixture));
