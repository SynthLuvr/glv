import { describe } from "vitest";
import { runCronChainSuite } from "../../glv/tests/suites/cron-chain.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("cron-chain", () => runCronChainSuite(claudeFixture));
