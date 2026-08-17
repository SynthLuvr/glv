import { type } from "arktype";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";

const HtmlString = type("string");

// One DOM window for the process — creating one per call leaks memory.
const purify = createDOMPurify(new JSDOM("").window);

// Markdown comes from session data written by the agent and from tool
// output, so it is untrusted; sanitize to prevent stored XSS.
const renderMarkdown = (md: string): string =>
  purify.sanitize(
    HtmlString.assert(marked.parse(md, { gfm: true, breaks: true })),
    { USE_PROFILES: { html: true } },
  );

export { renderMarkdown };
