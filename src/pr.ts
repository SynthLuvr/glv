import { type } from "arktype";
import { execa } from "execa";
import type { ParsedMessage } from "./format/index.js";
import { thinkingText, toolResultInfo } from "./format/index.js";

// Only full `github.com/owner/repo/pull/N` URLs count — shorthand `#N`
// collides with issues and changelog noise.
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const PR_URL_GLOBAL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// `gh pr create` prints nothing but the new PR's URL on success.
const BARE_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

// `git push` prints a create-PR link on a `remote:` line. Anchoring to
// `remote:` avoids matching the URL when merely quoted in prose.
const PULL_NEW_URL_GLOBAL =
  /^[ \t]*remote:[ \t]*(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/new\/[\w./-]+)/gm;

const findPrUrls = (text: string): string[] =>
  [...text.matchAll(PR_URL_GLOBAL)].map((match) => match[0]);

const findPullNewUrls = (text: string): string[] =>
  [...text.matchAll(PULL_NEW_URL_GLOBAL)].map((match) => match[1]);

const last = <T>(values: readonly T[]): T | undefined =>
  values.length === 0 ? undefined : values[values.length - 1];

// GitHub-MCP returns JSON with an `html_url` (preferred over the API `url`).
const PrJson = type({
  "html_url?": "string",
  "url?": "string",
});

const prUrlFromJson = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const record = PrJson(parsed);
  if (record instanceof type.errors) return undefined;
  const candidate = record.html_url ?? record.url;
  if (candidate !== undefined && PR_URL.test(candidate)) return candidate;
  return undefined;
};

// Ranked by confidence of being "the PR this session created". Higher rank
// always wins; within a rank the latest mention wins (recency beats
// frequency, which is gamed by changelogs). `pushLink` is intentionally
// excluded from the ranking: a `pull/new` link is an invitation, not a PR.
type PrCandidates = {
  created?: string;
  mcpResult?: string;
  summary?: string;
  mention?: string;
  pushLink?: string;
};

const recordMention = (text: string, out: PrCandidates): void => {
  out.mention = last(findPrUrls(text)) ?? out.mention;
};

const scanToolResult = (
  text: string,
  isError: boolean,
  out: PrCandidates,
): void => {
  const trimmed = text.trim();
  // Only a non-error bare URL counts as a creation (gh pr create exit 0).
  if (!isError && BARE_PR_URL.test(trimmed)) {
    out.created = trimmed;
    return;
  }
  const mcpUrl = prUrlFromJson(text);
  if (mcpUrl !== undefined) {
    out.mcpResult = mcpUrl;
    return;
  }
  const pushNew = last(findPullNewUrls(text));
  if (pushNew !== undefined) {
    out.pushLink = pushNew;
    return;
  }
  recordMention(text, out);
};

const scanText = (
  text: string,
  isAssistant: boolean,
  out: PrCandidates,
): void => {
  const url = last(findPrUrls(text));
  if (url === undefined) return;
  if (isAssistant) out.summary = url;
  else out.mention = url;
};

const scanMessage = (message: ParsedMessage, out: PrCandidates): void => {
  const isAssistant = message.role === "assistant";
  for (const item of message.items)
    if (item.type === "toolResponse") {
      const info = toolResultInfo(item);
      if (info !== undefined) scanToolResult(info.text, info.isError, out);
    } else if (item.type === "text" && item.text !== undefined) {
      scanText(item.text, isAssistant, out);
    } else if (item.type === "thinking") {
      const thought = thinkingText(item);
      if (thought !== undefined) recordMention(thought, out);
    }
};

// Reads only content already loaded for the page — no extra latency.
const scanCandidates = (messages: readonly ParsedMessage[]): PrCandidates => {
  const out: PrCandidates = {};
  for (const message of messages) scanMessage(message, out);
  return out;
};

const detectPrUrl = (
  messages: readonly ParsedMessage[],
): string | undefined => {
  const { created, mcpResult, summary, mention } = scanCandidates(messages);
  return created ?? mcpResult ?? summary ?? mention;
};

const detectCreatePrUrl = (
  messages: readonly ParsedMessage[],
): string | undefined => scanCandidates(messages).pushLink;

const prLabel = (url: string): string => {
  const match = /\/pull\/(\d+)/.exec(url);
  return match === null ? "PR" : `#${match[1]}`;
};

type PrState = "open" | "merged" | "closed" | "unknown";

type CommandResult = { stdout: string };

type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

const GH_TIMEOUT_MS = 8000;

// Reuses the user's `gh` auth. `reject: false` turns a non-zero exit into a
// result; a missing binary or timeout still throws (caught by resolvePrState).
const runGh = async (args: readonly string[]): Promise<CommandResult> => {
  const { stdout } = await execa("gh", [...args], {
    timeout: GH_TIMEOUT_MS,
    reject: false,
  });
  return { stdout };
};

// Judge by parsed state, not exit code: unauthed `gh` exits 0 but prints
// help text instead of JSON.
const GhStateView = type({ "state?": "string" });

const parseGhState = (stdout: string): PrState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "unknown";
  }
  const view = GhStateView(parsed);
  if (view instanceof type.errors) return "unknown";
  const { state } = view;
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "unknown";
};

// The URL round-trips through a query string — guard before passing to `gh`.
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

export type { CommandRunner, PrState };
export { detectCreatePrUrl, detectPrUrl, prLabel, resolvePrState, STATE_LABEL };
