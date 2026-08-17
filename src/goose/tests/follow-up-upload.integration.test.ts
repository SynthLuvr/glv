import { describe } from "vitest";
import { runFollowUpUploadSuite } from "../../glv/tests/suites/follow-up-upload.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("follow-up-upload", () => runFollowUpUploadSuite(gooseFixture));
