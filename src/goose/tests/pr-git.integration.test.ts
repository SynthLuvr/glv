import { describe } from "vitest";
import { runPrGitSuite } from "../../glv/tests/suites/pr-git.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("pr-git", () => runPrGitSuite(gooseFixture));
