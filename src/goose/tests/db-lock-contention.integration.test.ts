import { describe } from "vitest";
import { runDbLockContentionSuite } from "../../glv/tests/suites/db-lock-contention.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("db lock contention", () => runDbLockContentionSuite(gooseFixture));
