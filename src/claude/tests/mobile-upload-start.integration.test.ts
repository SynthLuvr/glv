import { describe } from "vitest";
import { runMobileUploadStartSuite } from "../../glv/tests/suites/mobile-upload-start.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("mobile-upload-start", () => runMobileUploadStartSuite(claudeFixture));
