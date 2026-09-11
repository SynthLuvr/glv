"use strict";

// Forward-clock-step simulation for the cron clock-step integration test
// (issue #272). WSL2 hosts re-step the guest clock thousands of times a
// day; when a step crosses a scheduled instant between croner's two
// clock reads while arming its timer, the occurrence is silently
// skipped. This preload reproduces that inside the real serve process:
// it is injected via NODE_OPTIONS "--require" (the same channel the
// harness uses for its subprocess-coverage observer) and armed by
// GLV_CLOCKSTEP_TARGET_MS — the epoch-ms instant the seeded one-shot
// job fires at.
//
// Until the target window opens, the clock this exposes is the real
// clock. The moment two reads land close together inside the final
// 31 seconds before the target — croner's arming reads come as one
// such cluster, because it never arms a timer longer than 30s — the
// clock steps forward across the target, landing a few seconds past
// it, exactly like a host resync. The step happens once; afterwards
// the clock runs real-time again, merely offset.
//
// Reads that are far apart (request handling, the cron database poll,
// logging) never trigger the step, so it cannot land on an unrelated
// read pair: only croner's back-to-back arming reads do.

const RealDate = Date;
const targetMs = Number(process.env.GLV_CLOCKSTEP_TARGET_MS ?? "");

// croner caps every armed timer at 30s, so its last arming reads always
// fall within 31s of the occurrence.
const WINDOW_MS = 31_000;

// Two reads this close together are one arming cluster. Generous enough
// to survive a GC pause between them, tight enough that no poll tick or
// request pair (seconds apart) can qualify.
const PAIR_MS = 50;

// How far past the occurrence the step lands.
const STEP_PAST_MS = 5_000;

const armed = Number.isFinite(targetMs) && targetMs > 0;

if (armed) {
  let offsetMs = 0;
  let jumped = false;
  let lastInWindow = false;
  let lastRealMs = Number.POSITIVE_INFINITY;

  const clockMs = () => {
    const realMs = RealDate.now();
    const gap = targetMs - (realMs + offsetMs);
    const inWindow = gap > 0 && gap <= WINDOW_MS;
    if (!jumped && inWindow && lastInWindow && realMs - lastRealMs <= PAIR_MS) {
      jumped = true;
      offsetMs += gap + STEP_PAST_MS;
      console.error(
        "[clockstep] injected forward clock step of " +
          `${gap + STEP_PAST_MS}ms across the scheduled instant ` +
          `(${Math.round(gap)}ms before it)`,
      );
    }
    lastInWindow = inWindow;
    lastRealMs = realMs;
    return realMs + offsetMs;
  };

  const PatchedDate = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clockMs());
      else super(...args);
    }

    static now() {
      return clockMs();
    }
  };

  globalThis.Date = PatchedDate;
}
