import { describe } from "vitest";
import { runCreateFailureCleanupSuite } from "../../glv/tests/suites/create-failure-cleanup.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("create-failure-cleanup", () =>
  runCreateFailureCleanupSuite(gooseFixture));
