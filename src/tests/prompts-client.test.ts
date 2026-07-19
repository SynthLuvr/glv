import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

// prompts.ts is a side-effect-only browser script (no exports). A non-literal
// specifier skips tsc's static module resolution while vitest still loads it.
const PROMPTS_MODULE = "../scripts/prompts";

const stubBrowser = (dom: JSDOM): void => {
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("HTMLFormElement", dom.window.HTMLFormElement);
  vi.stubGlobal("HTMLDetailsElement", dom.window.HTMLDetailsElement);
};

const click = (dom: JSDOM, el: Element): void => {
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
};

const dateString = (): string => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

describe("saved-prompt template substitution (new-session page)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("'Use' fills the textarea with known placeholders resolved", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<form class="new-session-form">',
        '  <input type="hidden" name="prompt_id" value="">',
        '  <input name="working_dir" value="/home/me/proj">',
        '  <input name="repo" value="">',
        '  <input name="branch" value="">',
        '  <textarea name="prompt"></textarea>',
        "</form>",
        "<div data-prompt-grid>",
        '  <article class="prompt-card" data-prompt-id="abc">',
        '    <span class="prompt-drag-handle">grip</span>',
        '    <button data-action="use" ',
        '      data-prompt-body="Review {{working_dir}} for {{topic}} ({{date}})">',
        "      Use",
        "    </button>",
        "  </article>",
        "</div>",
        "</body></html>",
      ].join(""),
    );
    stubBrowser(dom);
    await import(PROMPTS_MODULE);

    const btn = dom.window.document.querySelector('[data-action="use"]');
    expect(btn).not.toBeNull();
    click(dom, btn as Element);

    const textarea = dom.window.document.querySelector(
      'textarea[name="prompt"]',
    ) as HTMLTextAreaElement;
    // {{working_dir}} and {{date}} resolve; the unknown {{topic}} is left
    // literal for the user to edit before starting.
    expect(textarea.value).toBe(
      `Review /home/me/proj for {{topic}} (${dateString()})`,
    );
    // Loading via "Use" detaches from the prompt so usage isn't bumped.
    expect(
      (
        dom.window.document.querySelector(
          '[name="prompt_id"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("'Use' leaves an unset {{repo}} literal instead of blanking it", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<form class="new-session-form">',
        '  <input name="working_dir" value="/x">',
        '  <textarea name="prompt"></textarea>',
        "</form>",
        '<button data-action="use" data-prompt-body="clone {{repo}}">Use</button>',
        "</body></html>",
      ].join(""),
    );
    stubBrowser(dom);
    await import(PROMPTS_MODULE);

    const btn = dom.window.document.querySelector('[data-action="use"]');
    click(dom, btn as Element);
    const textarea = dom.window.document.querySelector(
      'textarea[name="prompt"]',
    ) as HTMLTextAreaElement;
    // No repo selected → {{repo}} stays literal (does NOT become "clone ").
    expect(textarea.value).toBe("clone {{repo}}");
  });
});

describe("in-session follow-up picker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fills the follow-up textarea with resolved placeholders", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<form class="prompt-bar" data-prompt-bar>',
        '  <details class="followup-picker" data-working-dir="/srv/app">',
        '    <button data-action="followup-use" ',
        '      data-prompt-body="Lint {{working_dir}} today ({{date}})">',
        "      Lint",
        "    </button>",
        "  </details>",
        '  <textarea name="prompt"></textarea>',
        "</form>",
        "</body></html>",
      ].join(""),
    );
    stubBrowser(dom);
    await import(PROMPTS_MODULE);

    const btn = dom.window.document.querySelector(
      '[data-action="followup-use"]',
    );
    click(dom, btn as Element);

    const textarea = dom.window.document.querySelector(
      '.prompt-bar textarea[name="prompt"]',
    ) as HTMLTextAreaElement;
    // The session's working dir resolves; repo/branch are unknown so they
    // would stay literal. The picker closes after inserting.
    expect(textarea.value).toBe(`Lint /srv/app today (${dateString()})`);
    expect(
      (
        dom.window.document.querySelector(
          ".followup-picker",
        ) as HTMLDetailsElement
      ).open,
    ).toBe(false);
  });

  it("does not touch the new-session textarea", async () => {
    const dom = new JSDOM(
      [
        "<!DOCTYPE html><html><body>",
        '<form class="new-session-form">',
        '  <input name="working_dir" value="/ns">',
        '  <textarea name="prompt">keep</textarea>',
        "</form>",
        '<form class="prompt-bar" data-prompt-bar>',
        '  <details class="followup-picker" data-working-dir="/followup">',
        '    <button data-action="followup-use" ',
        '      data-prompt-body="{{working_dir}}">x</button>',
        "  </details>",
        '  <textarea name="prompt"></textarea>',
        "</form>",
        "</body></html>",
      ].join(""),
    );
    stubBrowser(dom);
    await import(PROMPTS_MODULE);

    const btn = dom.window.document.querySelector(
      '[data-action="followup-use"]',
    );
    click(dom, btn as Element);

    const ns = dom.window.document.querySelector(
      ".new-session-form textarea",
    ) as HTMLTextAreaElement;
    expect(ns.value).toBe("keep");
  });
});
