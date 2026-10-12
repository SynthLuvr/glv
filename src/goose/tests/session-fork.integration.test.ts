import { describe } from "vitest";
import { runSessionForkSuite } from "../../glv/tests/suites/session-fork.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("session-fork", () => runSessionForkSuite(gooseFixture));
