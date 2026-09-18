"use strict";

// Simulates the forward clock step of issue #272 inside the serve
// process: loaded through NODE_OPTIONS "--require" (the same channel
// the harness uses for its subprocess-coverage observer) and armed by
// GLV_CLOCKSTEP_TARGET_MS, the epoch-ms instant the seeded one-shot
// fires at.
//
// croner never arms a timer longer than 30s, so its final arming reads
// always land within the last 31s before the occurrence — as one tight
// cluster of back-to-back Date calls. When two reads land that close
// together inside the window, the clock steps forward across the
// instant, landing a few seconds past it, exactly like a host resync —
// once; afterwards the clock merely runs offset. Reads seconds apart
// (request handling, the cron database poll, logging) never qualify,
// so the step cannot land on an unrelated read pair.

const RealDate = Date;
const targetMs = Number(process.env.GLV_CLOCKSTEP_TARGET_MS ?? "");

// croner caps every armed timer at 30s: its last arming cluster always
// falls within 31s of the occurrence.
const WINDOW_MS = 31_000;

// Two reads this close together are one arming cluster. Loose enough to
// survive a GC pause between them, tight enough that no poll tick or
// request pair (seconds apart) can qualify.
const PAIR_MS = 50;

// How far past the occurrence the step lands.
const STEP_PAST_MS = 5_000;

const armed = Number.isFinite(targetMs) && targetMs > 0;

if (armed) {
  let offsetMs = 0;
  let jumped = false;
  let lastInWindow = false;
  // Infinity so the first read inside the window cannot pair with a
  // pre-window read.
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
