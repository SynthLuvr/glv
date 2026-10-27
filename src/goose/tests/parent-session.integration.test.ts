import { describe } from "vitest";
import { runParentSessionSuite } from "../../glv/tests/suites/parent-session.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("parent session links", () => runParentSessionSuite(gooseFixture));
