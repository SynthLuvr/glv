#!/usr/bin/env node
// Cross-platform Node launcher for the goose viewer, published via
// package.json's "bin" field; bin/glv-goose (POSIX shell) is retained
// for direct Unix invocation. The launcher shape itself — tsx ordered
// below the coverage observer, argv repositioned around the entry,
// the ordered restart for an inherited NODE_OPTIONS hook — is
// type-a-bin's runCliAsMain (0.1.7, from SynthLuvr/type-a-bin#37): the
// CLI loads in this process as the main module, so signals reach it
// directly and its exit code is the launcher's own.
import { runCliAsMain } from "type-a-bin/subprocess-coverage/run-cli";

await runCliAsMain(new URL("../src/goose/cli.ts", import.meta.url));
