import { describe } from "vitest";
import { runGhGitSuite } from "../../glv/tests/suites/gh-git.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("gh-git", () => runGhGitSuite(gooseFixture));
