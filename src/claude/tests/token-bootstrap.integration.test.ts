import { describe } from "vitest";
import { runTokenBootstrapSuite } from "../../glv/tests/suites/token-bootstrap.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("token bootstrap", () => runTokenBootstrapSuite(claudeFixture));
