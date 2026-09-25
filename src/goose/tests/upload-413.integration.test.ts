import { describe } from "vitest";
import { runUpload413Suite } from "../../glv/tests/suites/upload-413.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("upload-413", () => runUpload413Suite(gooseFixture));
