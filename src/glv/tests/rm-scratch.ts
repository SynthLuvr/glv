import { type RmOptions, rmSync } from "node:fs";

// Windows can transiently deny deleting files a just-killed process still
// holds (SQLite WALs, shim exes); rmSync's retry options cover that and are
// harmless elsewhere. Antivirus or search indexing can hold temp files open
// indefinitely, so a cleanup that still fails after the retries warns
// instead of throwing: leftover debris must not fail a suite whose
// assertions all passed, and the OS temp cleaner catches the rest.
const RM_OPTIONS: RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 40,
  retryDelay: 250,
};

const rmScratch = (dir: string): void => {
  try {
    rmSync(dir, RM_OPTIONS);
  } catch (err) {
    console.error(`warning: could not remove ${dir}: ${String(err)}`);
  }
};

export { rmScratch };
