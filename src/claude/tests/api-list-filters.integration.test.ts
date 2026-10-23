import { describe } from "vitest";
import { runApiListFiltersSuite } from "../../glv/tests/suites/api-list-filters.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("api list filters", () => runApiListFiltersSuite(claudeFixture));
