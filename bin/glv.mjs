#!/usr/bin/env node
// Cross-platform Node launcher for the merged glv viewer, published via
// package.json's "bin" field; bin/glv (POSIX shell) is retained for
// direct Unix invocation. runCliAsMain loads the CLI as this process's
// main module (tsx first, and under subprocess coverage the observer
// ordered above it), so signals and the exit code are the CLI's own.
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

await runCliAsMain(new URL("../src/glv/cli.ts", import.meta.url));
