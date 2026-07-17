import { describe, expect, it } from "vitest";
import type { ContentItem, ParsedMessage } from "../format.js";
import type { CommandRunner } from "../pr.js";
import { detectPrUrl, prLabel, resolvePrState } from "../pr.js";

// --- synthetic message builders -------------------------------------------
// Mirrors the goose transcript shapes that `toolResultInfo` / `thinkingText`
// parse. Tests feed these mocked arrays — never the live, fluctuating DB.

const textItem = (text: string): ContentItem => ({ type: "text", text });

const thinkingItem = (text: string): ContentItem =>
  ({ type: "thinking", thinking: text }) as ContentItem;

const toolResult = (text: string, isError = false): ContentItem =>
  ({
    type: "toolResponse",
    toolResult: {
      value: { content: [{ type: "text", text }], isError },
    },
  }) as ContentItem;

const msg = (
  role: string,
  items: ContentItem[],
  ts = "2026-07-16 10:00:00",
): ParsedMessage => ({ role, timestamp: ts, items });

const URL = (n: number): string =>
  `https://github.com/SynthLuvr/lisko/pull/${n}`;

// --- detection ------------------------------------------------------------

describe("detectPrUrl", () => {
  it("returns undefined when no PR is mentioned", () => {
    const messages = [
      msg("user", [textItem("Please add a PR chip feature.")]),
      msg("assistant", [textItem("On it, here is the plan.")]),
    ];
    expect(detectPrUrl(messages)).toBeUndefined();
  });

  it("picks the bare-URL tool result of `gh pr create` (tier 1)", () => {
    const messages = [
      msg("user", [textItem("Make a PR please.")]),
      msg("user", [toolResult(URL(35))]),
    ];
    expect(detectPrUrl(messages)).toBe(URL(35));
  });

  it("ignores a bare URL in an *error* tool result for tier 1", () => {
    // gh pr create that failed still printed a URL-ish string; an error result
    // must not count as a successful creation, so tier 1 stays empty.
    const messages = [msg("user", [toolResult(URL(35), true)])];
    // Falls through to a tier-5 mention rather than a tier-1 creation.
    expect(detectPrUrl(messages)).toBe(URL(35));
  });

  it("keeps the *latest* created PR when several are made (tier 1)", () => {
    const messages = [
      msg("user", [toolResult(URL(33))]),
      msg("user", [toolResult(URL(37))]),
    ];
    expect(detectPrUrl(messages)).toBe(URL(37));
  });

  it("extracts the URL from a GitHub-MCP JSON result (tier 2)", () => {
    const json = JSON.stringify({
      number: 56,
      url: URL(56),
      state: "OPEN",
    });
    expect(detectPrUrl([msg("user", [toolResult(json)])])).toBe(URL(56));
  });

  it("prefers html_url over the API url in MCP JSON", () => {
    const json = JSON.stringify({
      html_url: URL(42),
      url: "https://api.github.com/repos/SynthLuvr/lisko/pulls/42",
    });
    expect(detectPrUrl([msg("user", [toolResult(json)])])).toBe(URL(42));
  });

  it("falls back to a `git push` pull/new link (tier 3)", () => {
    const pushOut =
      "remote: Create a pull request for 'feat/x' on GitHub by visiting:\n" +
      `remote:      https://github.com/SynthLuvr/lisko/pull/new/feat/x`;
    expect(detectPrUrl([msg("user", [toolResult(pushOut)])])).toBe(
      "https://github.com/SynthLuvr/lisko/pull/new/feat/x",
    );
  });

  it("chooses the assistant summary mention over reference noise (tier 4 > 5)", () => {
    // A dependency/changelog dump cites 125 foreign PRs in a tool result.
    const changelog = Array.from(
      { length: 125 },
      (_, i) => `https://github.com/aaif-goose/goose/pull/${i + 1}`,
    ).join("\n");
    const messages = [
      msg("user", [toolResult(changelog)]),
      // The real PR this session created only appears in the final summary.
      msg("assistant", [textItem(`Done — opened ${URL(56)} for review.`)]),
    ];
    expect(detectPrUrl(messages)).toBe(URL(56));
  });

  it("tier 1 wins even when a different PR is mentioned later in prose", () => {
    const messages = [
      msg("user", [toolResult(URL(35))]),
      msg("assistant", [textItem(`See also ${URL(99)}.`)]),
    ];
    expect(detectPrUrl(messages)).toBe(URL(35));
  });

  it("uses the last assistant mention when only text references exist (tier 4)", () => {
    const messages = [
      msg("assistant", [textItem(`Draft at ${URL(10)}`)]),
      msg("assistant", [textItem(`Final PR: ${URL(12)}`)]),
    ];
    expect(detectPrUrl(messages)).toBe(URL(12));
  });

  it("encodes the 20260716_56 fixture: one chip linking PR #35", () => {
    // Condensed real transcript of that session: a git push (tier 3), then the
    // gh pr create bare URL (tier 1), then an MCP read-back, then a summary.
    const messages = [
      msg("user", [
        toolResult(
          "remote: Create a pull request for 'fix/x' on GitHub by visiting:\n" +
            "remote:      https://github.com/SynthLuvr/goose-log-viewer/pull/new/fix/x",
        ),
      ]),
      msg("user", [
        toolResult("https://github.com/SynthLuvr/goose-log-viewer/pull/35"),
      ]),
      msg("assistant", [
        textItem(
          "Done. The PR is open at " +
            "https://github.com/SynthLuvr/goose-log-viewer/pull/35.",
        ),
      ]),
    ];
    expect(detectPrUrl(messages)).toBe(
      "https://github.com/SynthLuvr/goose-log-viewer/pull/35",
    );
  });

  it("encodes the 20260716_63 fixture: no chip (no PR at all)", () => {
    const messages = [
      msg("user", [textItem("Let's propose a new session UX.")]),
      msg("assistant", [
        thinkingItem("Drafting the design doc, no code changes."),
        textItem("Here is the proposal document."),
      ]),
    ];
    expect(detectPrUrl(messages)).toBeUndefined();
  });
});

// --- label ----------------------------------------------------------------

describe("prLabel", () => {
  it("renders #N for a numbered PR URL", () => {
    expect(prLabel(URL(35))).toBe("#35");
  });

  it("renders a bare label for a pull/new fallback URL", () => {
    expect(prLabel("https://github.com/SynthLuvr/lisko/pull/new/feat/x")).toBe(
      "PR",
    );
  });
});

// --- status resolver ------------------------------------------------------

const mockRunner =
  (stdout: string): CommandRunner =>
  async () => ({ stdout });

const throwingRunner = (): CommandRunner => async () => {
  throw new Error("spawn failed");
};

describe("resolvePrState", () => {
  it("maps gh OPEN/MERGED/CLOSED states", async () => {
    expect(await resolvePrState(URL(1), mockRunner('{"state":"OPEN"}'))).toBe(
      "open",
    );
    expect(await resolvePrState(URL(1), mockRunner('{"state":"MERGED"}'))).toBe(
      "merged",
    );
    expect(await resolvePrState(URL(1), mockRunner('{"state":"CLOSED"}'))).toBe(
      "closed",
    );
  });

  it("rejects an unauthed gh that exits 0 but prints a help message", async () => {
    expect(
      await resolvePrState(URL(1), mockRunner("Usage: gh pr view ...")),
    ).toBe("unknown");
  });

  it("rejects non-JSON / empty stdout (missing gh, timeout)", async () => {
    expect(await resolvePrState(URL(1), mockRunner(""))).toBe("unknown");
    expect(
      await resolvePrState(URL(1), mockRunner("Could not resolve to a PR")),
    ).toBe("unknown");
  });

  it("never throws when the runner fails", async () => {
    expect(await resolvePrState(URL(1), throwingRunner())).toBe("unknown");
  });

  it("never shells out for a non-PR URL", async () => {
    const calls: string[] = [];
    const spy: CommandRunner = async (args) => {
      calls.push(args.join(" "));
      return { stdout: '{"state":"OPEN"}' };
    };
    expect(await resolvePrState("https://evil.example/x", spy)).toBe("unknown");
    expect(calls).toEqual([]);
  });

  it("passes the expected gh invocation", async () => {
    const seen: readonly string[] = [];
    const spy: CommandRunner = async (args) => {
      (seen as string[]).push([...args].join(" "));
      return { stdout: '{"state":"MERGED"}' };
    };
    await resolvePrState(URL(7), spy);
    expect(seen).toEqual([`pr view ${URL(7)} --json state`]);
  });
});
