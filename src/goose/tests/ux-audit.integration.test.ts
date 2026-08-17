import { describe } from "vitest";
import { runUxAuditSuite } from "../../glv/tests/suites/ux-audit.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("ux-audit", () => runUxAuditSuite(gooseFixture));
