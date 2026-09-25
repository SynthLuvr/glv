import { buildAssets } from "./build.js";

// The merged product's asset build: the same client entries and
// stylesheet, emitted into dist/glv for `glv serve` to read.
buildAssets("glv");
