import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  baseDatabases,
  readCronJobRows,
  seedCronJobRow,
} from "../src/glv/tests/harness.js";

const scratch = mkdtempSync(join(tmpdir(), "seedboot-"));
const dbs = baseDatabases(scratch, {});
seedCronJobRow(dbs.cronDb, {
  name: "nightly",
  schedule: "0 9 * * *",
  prompt: "p",
  workingDir: "/tmp",
  enabled: true,
});
console.log("seeded rows:", JSON.stringify(readCronJobRows(dbs.cronDb)));

import { openCronDb } from "../src/glv/cron-jobs.js";

const db = openCronDb(dbs.cronDb, "claude");
console.log("after claude open:", JSON.stringify(readCronJobRows(dbs.cronDb)));
db.close();
