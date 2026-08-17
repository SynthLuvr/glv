import { describe } from "vitest";
import { runNewSessionSuite } from "../../glv/tests/suites/new-session.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("new-session", () => runNewSessionSuite(gooseFixture));
