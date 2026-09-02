import { describe } from "vitest";
import { runSessionModelSuite } from "../../glv/tests/suites/session-model.suite.js";
import { gooseFixture } from "./integration-harness.js";

// goose records the model on the session row; the chip surfaces it verbatim.
describe("session model chip", () =>
  runSessionModelSuite(gooseFixture, "glm-5.2"));
