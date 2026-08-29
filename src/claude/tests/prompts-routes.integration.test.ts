import { describe } from "vitest";
import { runPromptsRoutesSuite } from "../../glv/tests/suites/prompts-routes.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("prompts-routes", () => runPromptsRoutesSuite(claudeFixture));
