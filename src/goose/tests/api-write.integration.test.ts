import { describe } from "vitest";
import { runApiWriteSuite } from "../../glv/tests/suites/api-write.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api write", () => runApiWriteSuite(gooseFixture));
