import { describe } from "vitest";
import { runSessionDeleteSuite } from "../../glv/tests/suites/session-delete.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("session-delete", () => runSessionDeleteSuite(claudeFixture));
