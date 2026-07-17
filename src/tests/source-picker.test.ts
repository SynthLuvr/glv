import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// A git ref name that is valid and pushable but contains characters that
// break out of an HTML attribute when interpolated via innerHTML.
const XSS_PAYLOAD = `"><img src=x onerror=alert(document.domain)>`;

// source-picker.ts is a side-effect-only browser script (no exports, loaded as
// a classic <script>), so tsc treats it as a non-module and refuses a literal
// import. A non-literal specifier skips static resolution while vitest still
// resolves it at runtime.
const SOURCE_PICKER_MODULE = "../scripts/source-picker";

const stubBrowser = (dom: JSDOM, fetchImpl: unknown): void => {
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLOptionElement", dom.window.HTMLOptionElement);
  vi.stubGlobal("fetch", fetchImpl);
};

const jsonOk = (body: unknown): unknown => ({ json: async () => body });

// The payload must land as a literal attribute value, not parsed markup: no
// <img> is created and the breakout quote is HTML-escaped (&quot;).
const assertNoInjection = async (
  datalist: Element,
  dom: JSDOM,
): Promise<void> => {
  await vi.waitFor(() => {
    expect(datalist.querySelectorAll("option")).toHaveLength(1);
  });
  expect(datalist.querySelector("img")).toBeNull();
  expect(datalist.innerHTML).toContain("&quot;");
  const opt = datalist.querySelector("option");
  expect(opt).toBeInstanceOf(dom.window.HTMLOptionElement);
  expect(opt?.value).toBe(XSS_PAYLOAD);
};

describe("source-picker datalist rendering", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not inject markup from a malicious git branch name", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<input name="repo" value="evil/repo">',
        '<datalist id="gh-branches"></datalist>',
        "<div data-branch-field></div>",
        "</body></html>",
      ].join(""),
    );
    stubBrowser(
      dom,
      vi
        .fn()
        .mockResolvedValue(
          jsonOk({ ok: true, branches: [XSS_PAYLOAD], defaultBranch: "main" }),
        ),
    );

    await import(SOURCE_PICKER_MODULE);

    const repoInput = dom.window.document.querySelector('input[name="repo"]');
    if (repoInput === null) throw new Error("repo input missing");
    repoInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    const datalist = dom.window.document.getElementById("gh-branches");
    if (datalist === null) throw new Error("gh-branches datalist missing");
    await assertNoInjection(datalist, dom);
  });

  it("does not inject markup from a malicious repo name (defense in depth)", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<div data-source="github"></div>',
        '<datalist id="gh-repos"></datalist>',
        "</body></html>",
      ].join(""),
    );
    stubBrowser(
      dom,
      vi.fn().mockResolvedValue(
        jsonOk({
          ok: true,
          repos: [
            {
              nameWithOwner: XSS_PAYLOAD,
              visibility: "PUBLIC",
              isFork: false,
              updatedAt: "2024-01-02T03:04:05Z",
            },
          ],
        }),
      ),
    );

    await import(SOURCE_PICKER_MODULE);

    const github = dom.window.document.querySelector('[data-source="github"]');
    if (github === null) throw new Error("github segment missing");
    github.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    const datalist = dom.window.document.getElementById("gh-repos");
    if (datalist === null) throw new Error("gh-repos datalist missing");
    await assertNoInjection(datalist, dom);
  });
});
