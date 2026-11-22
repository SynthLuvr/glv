import { describe } from "vitest";
import { runStylesheetWatchdogSuite } from "../../glv/tests/suites/stylesheet-watchdog.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stylesheet watchdog", () => runStylesheetWatchdogSuite(gooseFixture));
