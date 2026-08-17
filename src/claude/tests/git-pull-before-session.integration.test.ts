import { describe } from "vitest";
import { runGitPullBeforeSessionSuite } from "../../glv/tests/suites/git-pull-before-session.suite.js";
import { claudeFixture } from "./integration-harness.js";

describe("git-pull-before-session", () =>
  runGitPullBeforeSessionSuite(claudeFixture));
