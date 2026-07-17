import { execa } from "execa";
import type { ParsedMessage } from "./format.js";
import { thinkingText, toolResultInfo } from "./format.js";

// Full GitHub PR URLs only — `github.com/owner/repo/pull/N`. Shorthand `#N`
// is deliberately excluded: it collides with issues, line refs and changelog
// noise, and is unsafe to treat as "the PR this session created".
// Non-global variant for single-match `test()` checks.
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

// Global variant for collecting every mention in a body of text.
const PR_URL_GLOBAL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// A tool result whose *entire* stdout is one bare PR URL is the distinctive
// signature of a successful `gh pr create` (exit 0): the command prints
// nothing but the new PR's URL.
const BARE_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// `git push` of a new branch prints a "create a PR" link:
//   remote: Create a pull request for 'feat/x' on GitHub by visiting:
//   remote:      https://github.com/owner/repo/pull/new/feat/x
const PULL_NEW_URL_GLOBAL =
  /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/new\/[\w./-]+/g;

const findPrUrls = (text: string): string[] =>
  [...text.matchAll(PR_URL_GLOBAL)].map((match) => match[0]);

const findPullNewUrls = (text: string): string[] =>
  [...text.matchAll(PULL_NEW_URL_GLOBAL)].map((match) => match[0]);

const isBarePrUrl = (text: string): boolean => BARE_PR_URL.test(text.trim());

// Tier 2: a GitHub-MCP tool result is JSON carrying a PR `url` (and usually a
// `state`). The GitHub REST shape exposes the human URL as `html_url` while
// `url` is the API endpoint, so prefer `html_url` and validate it really is a
// github.com PR link before accepting it. Only the *whole* trimmed text being a
// JSON object qualifies — embedded JSON inside prose falls through to tier 5.
const prUrlFromJson = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.html_url ?? record.url;
  if (typeof candidate === "string" && PR_URL.test(candidate)) return candidate;
  return undefined;
};

// Last element of an array (undefined when empty) — every tier's tie-break is
// "latest wins", so we only ever keep the most recent candidate.
const last = <T>(values: readonly T[]): T | undefined =>
  values.length === 0 ? undefined : values[values.length - 1];

type PrCandidates = {
  tier1: string | undefined;
  tier2: string | undefined;
  tier3: string | undefined;
  tier4: string | undefined;
  tier5: string | undefined;
};

const scanMessage = (message: ParsedMessage, out: PrCandidates): void => {
  const isAssistant = message.role === "assistant";
  for (const item of message.items) {
    if (item.type === "toolResponse") {
      const info = toolResultInfo(item);
      if (info === undefined) continue;
      const text = info.text;
      // Tier 1 requires a non-error result (the exit-0 success of gh pr create).
      if (!info.isError && isBarePrUrl(text)) out.tier1 = text.trim();
      else {
        const jsonUrl = prUrlFromJson(text);
        if (jsonUrl !== undefined) out.tier2 = jsonUrl;
        else {
          const newUrl = last(findPullNewUrls(text));
          if (newUrl !== undefined) out.tier3 = newUrl;
          else out.tier5 = last(findPrUrls(text)) ?? out.tier5;
        }
      }

      continue;
    }
    if (item.type === "text" && item.text !== undefined) {
      const url = last(findPrUrls(item.text));
      if (url !== undefined)
        if (isAssistant) out.tier4 = url;
        else out.tier5 = url;

      continue;
    }
    if (item.type === "thinking") {
      const text = thinkingText(item);
      if (text !== undefined) out.tier5 = last(findPrUrls(text)) ?? out.tier5;
    }
  }
};

// Pure, offline, deterministic: `messages -> { url } | undefined`.
// Reads only content already loaded for the page, so it is cheap and adds no
// latency to the initial render. The first tier that yields a candidate
// decides; within every tier the tie-break is "latest wins" (recency tracks
// "the PR the session ended on"; frequency is gamed by changelogs).
const detectPrUrl = (
  messages: readonly ParsedMessage[],
): string | undefined => {
  const out: PrCandidates = {
    tier1: undefined,
    tier2: undefined,
    tier3: undefined,
    tier4: undefined,
    tier5: undefined,
  };
  for (const message of messages) scanMessage(message, out);
  return out.tier1 ?? out.tier2 ?? out.tier3 ?? out.tier4 ?? out.tier5;
};

// "#35" for a real PR; a bare "PR" label otherwise (e.g. a `pull/new/<branch>`
// fallback URL has no number). Drives the chip's compact display.
const prLabel = (url: string): string => {
  const match = /\/pull\/(\d+)/.exec(url);
  return match === null ? "PR" : `#${match[1]}`;
};

type PrState = "open" | "merged" | "closed" | "unknown";

type CommandResult = { stdout: string };

/** Subprocess runner; tests inject a fake to avoid spawning real `gh`. */
type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

const GH_TIMEOUT_MS = 8000;

// Reuses the user's existing `gh` auth — no token, no API key. `reject: false`
// turns a non-zero exit (unauthed, missing PR) into a result we inspect rather
// than a thrown error; a missing binary or timeout is caught and yields empty
// stdout, which parses to "unknown".
const runGh = async (args: readonly string[]): Promise<CommandResult> => {
  try {
    const result = await execa("gh", [...args], {
      timeout: GH_TIMEOUT_MS,
      reject: false,
    });
    return { stdout: typeof result.stdout === "string" ? result.stdout : "" };
  } catch {
    return { stdout: "" };
  }
};

// Success is judged by *successfully parsing stdout into a recognized state*
// — not by exit code alone. An unauthed `gh` exits 0 but prints a help message
// instead of JSON; a missing binary, timeout or network failure yields empty or
// non-JSON output. Every one of those degrades to "unknown".
const parseGhState = (stdout: string): PrState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  if (typeof parsed !== "object" || parsed === null) return "unknown";
  const state = (parsed as { state?: unknown }).state;
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "unknown";
};

// Guard so only a real GitHub PR URL is ever handed to `gh`, regardless of
// where the value originated (it round-trips through a query string).
const isPrUrl = (url: string): boolean =>
  PR_URL.test(url) || /\/pull\/new\/[\w./-]+$/.test(url);

const resolvePrState = async (
  url: string,
  run: CommandRunner = runGh,
): Promise<PrState> => {
  if (!isPrUrl(url)) return "unknown";
  try {
    const result = await run(["pr", "view", url, "--json", "state"]);
    return parseGhState(result.stdout);
  } catch {
    return "unknown";
  }
};

const STATE_LABEL: Record<Exclude<PrState, "unknown">, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export type { CommandResult, CommandRunner, PrState };
export { detectPrUrl, prLabel, resolvePrState, runGh, STATE_LABEL };
