#!/usr/bin/env node
// Compatibility shim for the merged product (ADR 0007 stage 3): the
// claude-only viewer is now `glv --agent claude`. Flags pass through
// unchanged.
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

process.argv.splice(2, 0, "--agent", "claude");
await runCliAsMain(new URL("../src/glv/cli.ts", import.meta.url));
