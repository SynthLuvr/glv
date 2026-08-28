import { rm } from "node:fs/promises";
import baseCoverageV8 from "@vitest/coverage-v8";
import { V8CoverageProvider } from "@vitest/coverage-v8/dist/provider.js";
import type { CoverageProviderModule, ReportContext } from "vitest/node";
import {
  mergeSubprocessCoverage,
  RAW_COVERAGE_ENV,
} from "./subprocess-coverage.js";

// Custom vitest coverage provider that folds subprocess coverage into
// the v8 report.
//
// glv's integration tests spawn the real `glv-goose` / `glv-claude`
// launchers (servers, CLI runs); vitest's stock v8 provider only collects
// coverage from the in-process test workers, so all that child-process
// code used to report as 0% despite being comprehensively exercised.
// This provider extends the stock one and, after the normal in-process
// collection, merges the raw NODE_V8_COVERAGE profiles written by the
// spawned processes — remapped through the transforms recorded by
// src/glv/tests/coverage-hook.mjs (see subprocess-coverage.ts for the
// full pipeline description).
//
// Wired in vitest.config.ts via coverage.customProviderModule; the
// worker-side hooks (startCoverage/takeCoverage/stopCoverage) are
// re-exported from the stock module unchanged.

class SubprocessV8CoverageProvider extends V8CoverageProvider {
  // Raw subprocess profiles must not leak across runs: vitest calls
  // clean() before every run (and between watch reruns), so stale
  // profiles from a previous run can never inflate this one. The stock
  // clean already removes reportsDirectory; this also empties the raw
  // directory wherever it lives.
  override async clean(doClean = true) {
    await super.clean(doClean);
    const rawDir = process.env[RAW_COVERAGE_ENV];
    if (doClean && rawDir !== undefined && rawDir !== "")
      await rm(rawDir, { recursive: true, force: true });
  }

  override async generateCoverage(context: ReportContext) {
    const coverageMap = await super.generateCoverage(context);
    const rawDir = process.env[RAW_COVERAGE_ENV];
    if (rawDir === undefined || rawDir === "") return coverageMap;
    try {
      const merged = await mergeSubprocessCoverage(
        coverageMap,
        rawDir,
        (path) => this.isIncluded(path),
      );
      if (merged > 0)
        this.ctx.logger.log(
          ` % ` +
            `merged subprocess coverage for ${merged} files into the report`,
        );
    } catch (err) {
      // Subprocess coverage is additive; a failure here must not lose
      // the in-process report.
      this.ctx.logger.error(`subprocess coverage merge failed: ${String(err)}`);
    }
    return coverageMap;
  }

  // The raw profile directory holds ~a GB of JSON for a full run; once
  // the report (and threshold checks) have completed it has served its
  // purpose. cleanAfterRun is skipped when threshold checks throw, so a
  // failing run keeps its raw data for debugging; GLV_KEEP_RAW=1 keeps
  // it on green runs too (investigating run-to-run coverage variance).
  override async cleanAfterRun(): Promise<void> {
    await super.cleanAfterRun();
    if (process.env.GLV_KEEP_RAW !== "1") {
      const rawDir = process.env[RAW_COVERAGE_ENV];
      if (rawDir !== undefined && rawDir !== "")
        await rm(rawDir, { recursive: true, force: true });
    }
  }
}

const mod: CoverageProviderModule = {
  ...baseCoverageV8,
  getProvider: () => new SubprocessV8CoverageProvider(),
};

export { mod as default };
