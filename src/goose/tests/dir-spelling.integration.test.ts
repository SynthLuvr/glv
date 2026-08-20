import { describe } from "vitest";
import { runDirSpellingSuite } from "../../glv/tests/suites/dir-spelling.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("dir-spelling", () => runDirSpellingSuite(gooseFixture));
