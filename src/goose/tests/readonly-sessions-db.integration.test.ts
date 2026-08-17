import { describe } from "vitest";
import { runReadonlySessionsSuite } from "../../glv/tests/suites/readonly-sessions-db.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("readonly-sessions-db", () => runReadonlySessionsSuite(gooseFixture));
