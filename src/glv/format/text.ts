import { homedir, platform } from "node:os";
import humanizeDuration from "humanize-duration";

const IS_WIN = platform() === "win32";

// Relative ages stay compact by design ("3m ago", not "3 minutes ago") —
// sidebar and transcript rows are dense — so the humanizer speaks a
// one-letter language, one rounded unit, with the spacer dropped.
const relativeAge = humanizeDuration.humanizer({
  language: "compact",
  languages: {
    compact: { d: () => "d", h: () => "h", m: () => "m", w: () => "w" },
  },
  spacer: "",
  largest: 1,
  round: true,
  units: ["w", "d", "h", "m"],
});

// Windows home prefixes must match across separator style and drive-letter
// case (homedir() says C:\Users\u while git and the agents emit c:\users\u
// or C:/users/u), so both sides are folded for the comparison; the emitted
// suffix keeps the target's original casing.
const shortenHomeWindows = (path: string, home: string): string => {
  const base = home.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const target = path.replaceAll("\\", "/");
  const lower = target.toLowerCase();
  if (lower === base) return "~";
  if (!lower.startsWith(`${base}/`)) return path;
  return `~/${target.slice(base.length + 1).replace(/^\/+/, "")}`;
};

// POSIX keeps exact byte matching: "\" and letter case are meaningful
// inside filenames.
const shortenHome = (path: string, home: string = homedir()): string => {
  if (home === "") return path;
  if (IS_WIN) return shortenHomeWindows(path, home);
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  return path;
};

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const truncateMiddle = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = Math.floor((max - 1) * 0.4);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
};

const fmtTokens = (n: number | null): string =>
  n === null ? "-" : n.toLocaleString("en-US");

const formatDate = (epoch: number, now: number): string => {
  const date = new Date(epoch);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
  };
  if (date.getFullYear() !== new Date(now).getFullYear())
    options.year = "numeric";
  return date.toLocaleDateString("en-US", options);
};

// Timestamps may be UTC but lack a zone suffix (SQLite CURRENT_TIMESTAMP),
// so anchor zone-less values to UTC — otherwise Date.parse and the
// <time datetime> attribute would read them as local time. An explicit
// designator is honoured when present.
const toIso = (timestamp: string): string => {
  const iso = timestamp.replace(" ", "T");
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  return hasZone ? iso : `${iso}Z`;
};

const parseTimestamp = (timestamp: string): number =>
  Date.parse(toIso(timestamp));

const JUST_NOW_MS = 45_000;
const FIVE_WEEKS_MS = 5 * 7 * 86_400_000;

const fmtRelative = (timestamp: string, now: number = Date.now()): string => {
  const then = parseTimestamp(timestamp);
  if (Number.isNaN(then)) return timestamp;
  const elapsedMs = now - then;
  if (elapsedMs < JUST_NOW_MS) return "just now";
  if (elapsedMs < FIVE_WEEKS_MS) return `${relativeAge(elapsedMs)} ago`;
  return formatDate(then, now);
};

export {
  fmtRelative,
  fmtTokens,
  parseTimestamp,
  shortenHome,
  toIso,
  truncate,
  truncateMiddle,
};
