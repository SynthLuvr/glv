import { describe } from "vitest";
import { runLocationSuite } from "../../glv/tests/suites/location.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("location", () => runLocationSuite(gooseFixture));
