import { describe } from "vitest";
import { runUploadSuite } from "../../glv/tests/suites/upload.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("upload", () => runUploadSuite(gooseFixture));
