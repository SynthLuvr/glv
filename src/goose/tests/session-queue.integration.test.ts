import { describe } from "vitest";
import { runSessionQueueSuite } from "../../glv/tests/suites/session-queue.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("session queue", () => runSessionQueueSuite(gooseFixture));
