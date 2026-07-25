import { homedir } from "node:os";

const shortenHome = (path: string, home: string = homedir()): string => {
  if (home === "") return path;
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

// Goose timestamps are UTC but lack a zone suffix (SQLite CURRENT_TIMESTAMP),
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

const fmtRelative = (timestamp: string, now: number = Date.now()): string => {
  const then = parseTimestamp(timestamp);
  if (Number.isNaN(then)) return timestamp;
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return formatDate(then, now);
};

export { fmtRelative, fmtTokens, shortenHome, toIso, truncate, truncateMiddle };
