import { describe } from "vitest";
import { runGroupsSuite } from "../../glv/tests/suites/groups.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("groups", () => runGroupsSuite(claudeFixture));
