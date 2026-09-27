import { authedFetch, type IntegrationEnv } from "./harness.js";

// Helpers shared by the cron suites (cron, cron-chain, cron-clockstep,
// cron-catchup, cron-ui): timing polls and the sidebar/session-count
// and one-shot-schedule spells they lean on. Pure test plumbing — no
// contract of the suites lives here.

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Polls predicate on a fixed interval until it holds or the deadline
// passes; resolves to whether it ever held (a false outcome is itself
// the assertion in the "never happens" tests).
const pollUntil = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
};

// Counts a session-name's occurrences in the sidebar markup — the
// sidebar renders each session's name exactly once, so the count is the
// number of live sessions carrying that name.
const countSessions = async (
  env: IntegrationEnv,
  sessionName: string,
): Promise<number> => {
  const res = await authedFetch(env, "/");
  const html = await res.text();
  return html.split(`class="session-name">${sessionName}<`).length - 1;
};

// Appends :ss to a minute-precision one-shot spelling so a test can aim
// a fixed distance out instead of waiting for a minute boundary. Zone
// offsets are minute-aligned, so an instant's seconds are its seconds
// in every zone — the target's own seconds serve zoned spellings too.
const withSeconds = (schedule: string, target: Date): string =>
  `${schedule}:${String(target.getSeconds()).padStart(2, "0")}`;

export { countSessions, pollUntil, sleep, withSeconds };
