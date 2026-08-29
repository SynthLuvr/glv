import { describe } from "vitest";
import { runPromptsRoutesSuite } from "../../glv/tests/suites/prompts-routes.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("prompts-routes", () => runPromptsRoutesSuite(gooseFixture));
