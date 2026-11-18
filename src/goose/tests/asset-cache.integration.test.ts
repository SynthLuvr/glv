import { describe } from "vitest";
import { runAssetCacheSuite } from "../../glv/tests/suites/asset-cache.suite.js";
import { gooseFixture } from "./integration-harness.js";

describe("asset cache", () => runAssetCacheSuite(gooseFixture));
