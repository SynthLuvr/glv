import { type } from "arktype";
import type { ParsedMessage } from "./format/index.js";
import { thinkingText, toolResultInfo } from "./format/index.js";
import { tryParseJson } from "./parse.js";

// Only full `github.com/owner/repo/pull/N` URLs count — shorthand `#N`
// collides with issues and changelog noise.
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const PR_URL_GLOBAL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// `gh pr create` prints nothing but the new PR's URL on success.
const BARE_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;

const findPrUrls = (text: string): string[] =>
  [...text.matchAll(PR_URL_GLOBAL)].map((match) => match[0]);

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
  const parsed = tryParseJson(trimmed);
  if (parsed === null) return undefined;
  const record = PrJson(parsed);
  if (record instanceof type.errors) return undefined;
  const candidate = record.html_url ?? record.url;
  if (candidate !== undefined && PR_URL.test(candidate)) return candidate;
  return undefined;
};

// Ranked by confidence of being "the PR this session created". Higher rank
// always wins; within a rank the latest mention wins (recency beats
// frequency, which is gamed by changelogs).
type PrCandidates = {
  created?: string;
  mcpResult?: string;
  summary?: string;
  mention?: string;
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
  // Incidental tool output (diffs, file listings) isn't a session-created
  // PR — scanning it for mentions caused false chips.
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

const prLabel = (url: string): string => {
  const match = /\/pull\/(\d+)/.exec(url);
  return match === null ? "PR" : `#${match[1]}`;
};

export { detectPrUrl, PR_URL, prLabel };
