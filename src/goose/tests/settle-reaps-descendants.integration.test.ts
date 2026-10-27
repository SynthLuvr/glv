import { describe } from "vitest";
import { runSettleReapsDescendantsSuite } from "../../glv/tests/suites/settle-reaps-descendants.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("settle-reaps-descendants", () =>
  runSettleReapsDescendantsSuite(gooseFixture));
