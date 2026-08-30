#!/usr/bin/env node
// Cross-platform Node launcher for the claude viewer, published via
// package.json's "bin" field; bin/glv-claude (POSIX shell) is retained
// for direct Unix invocation. runCliAsMain loads the CLI as this
// process's main module (tsx first, and under subprocess coverage the
// observer ordered above it), so signals and the exit code are the
// CLI's own.
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

await runCliAsMain(new URL("../src/claude/cli.ts", import.meta.url));
