import { describe } from "vitest";
import { runSingleScrollbarSuite } from "../../glv/tests/suites/single-scrollbar.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("single-scrollbar", () => runSingleScrollbarSuite(claudeFixture));
