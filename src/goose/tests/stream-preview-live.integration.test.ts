import { describe } from "vitest";
import { runStreamPreviewLiveSuite } from "../../glv/tests/suites/stream-preview-live.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("stream-preview-live", () => runStreamPreviewLiveSuite(gooseFixture));
