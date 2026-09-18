import { describe } from "vitest";
import { runSseContractSuite } from "../../glv/tests/suites/sse-contract.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("sse-contract", () => runSseContractSuite(gooseFixture));
