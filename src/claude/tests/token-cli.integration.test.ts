import { describe } from "vitest";
import { runTokenCliSuite } from "../../glv/tests/suites/token-cli.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("token cli", () => runTokenCliSuite(claudeFixture));
