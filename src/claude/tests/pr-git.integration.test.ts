import { describe } from "vitest";
import { runPrGitSuite } from "../../glv/tests/suites/pr-git.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("pr-git", () => runPrGitSuite(claudeFixture));
