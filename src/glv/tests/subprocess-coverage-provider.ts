import { rm } from "node:fs/promises";
import baseCoverageV8 from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import type { CoverageProviderModule, ReportContext } from "vitest/node";
import {
  type MergeableCoverageMap,
  mergeSubprocessCoverage,
  rawCoverageDir,
} from "./subprocess-coverage.js";

// The stock v8 provider plus a merge of the raw NODE_V8_COVERAGE
// profiles written by the server/CLI subprocesses the integration suite
// spawns — see subprocess-coverage.ts for the pipeline. Wired in via
// coverage.customProviderModule; the worker-side hooks
// (startCoverage/takeCoverage/stopCoverage) are re-exported from the
// stock module unchanged.
class SubprocessV8CoverageProvider extends V8CoverageProvider {
  // vitest calls clean() before every run (and between watch reruns);
  // stale raw profiles from a previous run must not inflate this one.
  override async clean(doClean = true) {
    await super.clean(doClean);
    const rawDir = rawCoverageDir();
    if (doClean && rawDir !== undefined)
      await rm(rawDir, { recursive: true, force: true });
  }

  override async generateCoverage(context: ReportContext) {
    const coverageMap = await super.generateCoverage(context);
    const rawDir = rawCoverageDir();
    if (rawDir !== undefined)
      try {
        await this.mergeRawProfiles(rawDir, coverageMap);
      } catch (err) {
        this.ctx.logger.error(
          `subprocess coverage merge failed: ${String(err)}`,
        );
      }

    return coverageMap;
  }

  private async mergeRawProfiles(
    rawDir: string,
    coverageMap: MergeableCoverageMap,
  ): Promise<void> {
    const merged = await mergeSubprocessCoverage(coverageMap, rawDir, (path) =>
      this.isIncluded(path),
    );
    if (merged > 0)
      this.ctx.logger.log(
        ` % merged subprocess coverage for ${merged} files into the report`,
      );
  }

  // The raw profile directory holds ~a GB of JSON for a full run and has
  // served its purpose once the report (and threshold checks) completed.
  // cleanAfterRun is skipped when thresholds throw, so a failing run
  // keeps its raw data for debugging; GLV_KEEP_RAW=1 keeps it on green
  // runs too (investigating run-to-run coverage variance).
  override async cleanAfterRun(): Promise<void> {
    await super.cleanAfterRun();
    const rawDir = rawCoverageDir();
    if (process.env.GLV_KEEP_RAW !== "1" && rawDir !== undefined)
      await rm(rawDir, { recursive: true, force: true });
  }
}

const providerModule: CoverageProviderModule = {
  ...baseCoverageV8,
  getProvider: () => new SubprocessV8CoverageProvider(),
};

export { providerModule as default };
