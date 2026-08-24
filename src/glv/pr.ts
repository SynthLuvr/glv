import type { ParsedMessage } from "./format/index.js";
import { thinkingText, toolResultInfo } from "./format/index.js";
import { parseJson } from "./parse.js";

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

// The code-execution tool wraps an MCP return value in a
// "Code Executed Successfully: …\n# Return Value\n```json …```" envelope, so
// the JSON may not start at column 0. Recover it from the fenced block.
const FENCED_JSON = /```json([\s\S]*?)```/;
const extractJson = (text: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  return FENCED_JSON.exec(trimmed)?.[1].trim() || undefined;
};

// A value may embed the URL inside a human-readable blob; return only the
// bare URL so prose doesn't leak into the chip (20260721_57).
const prUrlInString = (text: string): string | undefined =>
  PR_URL.exec(text)?.[0];

// Walk a parsed JSON value for a `github.com/…/pull/N` URL. Search and
// collection payloads nest the PR under `items`, so a flat top-level check
// misses them. `html_url` is preferred: it is GitHub's canonical web link,
// whereas `url` is an API endpoint (and may point at `/issues/` for a PR).
const findPrUrlInValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return prUrlInString(value);
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const htmlUrl = record.html_url;
  if (typeof htmlUrl === "string") {
    const found = prUrlInString(htmlUrl);
    if (found !== undefined) return found;
  }
  for (const child of Object.values(record)) {
    const found = findPrUrlInValue(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

const prUrlFromJson = (text: string): string | undefined => {
  const jsonStr = extractJson(text);
  if (jsonStr === undefined) return undefined;
  const parsed = parseJson(jsonStr);
  if (!parsed.ok) return undefined;
  return findPrUrlInValue(parsed.data);
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
