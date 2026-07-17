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

// Goose writes session/message timestamps in UTC without a zone suffix
// (both the SQLite CURRENT_TIMESTAMP defaults and the created_timestamp
// UTC epoch corroborate this against the live DB). Date.parse would read a
// zone-less value as local time, so anchor zone-less values to UTC and
// honour an explicit zone designator when one is present.
const parseTimestamp = (timestamp: string): number => {
  const iso = timestamp.replace(" ", "T");
  const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso);
  return Date.parse(hasZone ? iso : `${iso}Z`);
};

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

export { fmtRelative };
