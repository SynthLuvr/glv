import { describe } from "vitest";
import { runGroupsRoutesSuite } from "../../glv/tests/suites/groups-routes.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("groups-routes", () => runGroupsRoutesSuite(claudeFixture));
