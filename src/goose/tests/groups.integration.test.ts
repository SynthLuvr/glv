import { describe } from "vitest";
import { runGroupsSuite } from "../../glv/tests/suites/groups.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("groups", () => runGroupsSuite(gooseFixture));
