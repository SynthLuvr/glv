import { describe } from "vitest";
import { runLauncherSuite } from "../../glv/tests/suites/launcher.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("launcher", () => runLauncherSuite(claudeFixture));
