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

export { fmtTokens, shortenHome, truncate, truncateMiddle };
