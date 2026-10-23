import { describe } from "vitest";
import { runApiListFiltersSuite } from "../../glv/tests/suites/api-list-filters.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("api list filters", () => runApiListFiltersSuite(gooseFixture));
