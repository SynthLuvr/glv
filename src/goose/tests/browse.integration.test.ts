import { describe } from "vitest";
import { runBrowseSuite } from "../../glv/tests/suites/browse.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("browse", () => runBrowseSuite(gooseFixture));
