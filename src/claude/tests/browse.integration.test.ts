import { describe } from "vitest";
import { runBrowseSuite } from "../../glv/tests/suites/browse.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("browse", () => runBrowseSuite(claudeFixture));
