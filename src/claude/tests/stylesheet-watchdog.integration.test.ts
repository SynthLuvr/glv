import { describe } from "vitest";
import { runStylesheetWatchdogSuite } from "../../glv/tests/suites/stylesheet-watchdog.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("stylesheet watchdog", () =>
  runStylesheetWatchdogSuite(claudeFixture));
