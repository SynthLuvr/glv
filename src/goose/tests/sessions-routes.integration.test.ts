import { describe } from "vitest";
import { runSessionsRoutesSuite } from "../../glv/tests/suites/sessions-routes.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("sessions-routes", () => runSessionsRoutesSuite(gooseFixture));
