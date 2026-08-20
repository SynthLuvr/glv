import { type RmOptions, rmSync } from "node:fs";

// Windows can transiently deny deleting files a just-killed process still
// holds (SQLite WALs, shim exes) — rmSync's retry options cover that.
// Antivirus or indexing can hold temp files open indefinitely, so a
// still-failing cleanup warns instead of failing a suite that passed.
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
