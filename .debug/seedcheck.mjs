import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCronJobRows, seedCronJobRow } from "../src/glv/tests/harness.js";

const dir = mkdtempSync(join(tmpdir(), "seedcheck-"));
const db = join(dir, "cron.db");
seedCronJobRow(db, {
  name: "nightly",
  schedule: "0 9 * * *",
  prompt: "p",
  workingDir: "/tmp",
  enabled: true,
});
console.log("after seed:", JSON.stringify(readCronJobRows(db)));
