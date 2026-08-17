import { describe } from "vitest";
import { runFollowUpUploadSuite } from "../../glv/tests/suites/follow-up-upload.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("follow-up-upload", () => runFollowUpUploadSuite(claudeFixture));
