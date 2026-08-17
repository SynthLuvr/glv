import { describe } from "vitest";
import { runStatusFeedSuite } from "../../glv/tests/suites/status-feed.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("status-feed", () => runStatusFeedSuite(gooseFixture));
