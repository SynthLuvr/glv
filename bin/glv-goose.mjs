#!/usr/bin/env node
// Compatibility shim for the merged product (ADR 0007 stage 3): the
// goose-only viewer is now `glv --agent goose`. Flags pass through
// unchanged, except the sessions database global, which the merged CLI
// spells --goose-db.
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

process.argv.splice(2, 0, "--agent", "goose");
await runCliAsMain(new URL("../src/glv/cli.ts", import.meta.url));
