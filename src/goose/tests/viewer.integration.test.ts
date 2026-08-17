import { describe } from "vitest";
import { runViewerSuite } from "../../glv/tests/suites/viewer.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("viewer", () => runViewerSuite(gooseFixture));
