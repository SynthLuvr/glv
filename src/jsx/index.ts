const REPLACE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => REPLACE[c]);

// A string already known to be safe HTML; rendered verbatim, never escaped.
type RawHtml = { readonly __raw: true; readonly html: string };

const raw = (html: string): RawHtml => ({ __raw: true, html });

const isRaw = (value: unknown): value is RawHtml =>
  typeof value === "object" &&
  value !== null &&
  (value as { __raw?: boolean }).__raw === true;

// Void/empty elements have no end tag.
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Boolean attributes render as a bare name when true.
const BOOLEAN_ATTRS = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "download",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "itemscope",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

// React-style camelCase aliases mapped to their HTML attribute names.
const ATTR_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  crossOrigin: "crossorigin",
  httpEquiv: "http-equiv",
  itemProp: "itemprop",
  fetchPriority: "fetchpriority",
  noModule: "nomodule",
  formAction: "formaction",
};

const renderChild = (child: unknown): string => {
  if (child === null || child === undefined || typeof child === "boolean")
    return "";
  if (typeof child === "string") return escapeHtml(child);
  if (isRaw(child)) return child.html;
  if (typeof child === "number" || typeof child === "bigint")
    return String(child);
  if (Array.isArray(child)) return child.map(renderChild).join("");
  return "";
};

const renderAttr = (rawName: string, value: unknown): string => {
  const name = ATTR_ALIASES[rawName] ?? rawName;
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") {
    if (BOOLEAN_ATTRS.has(name)) return value ? ` ${name}=""` : "";
    return ` ${name}="${value}"`;
  }
  if (isRaw(value)) return ` ${name}="${value.html}"`;
  if (typeof value === "number" || typeof value === "bigint")
    return ` ${name}="${value}"`;
  if (typeof value === "string") return ` ${name}="${escapeHtml(value)}"`;
  return "";
};

const Fragment = (props: { children?: unknown }): RawHtml =>
  raw(renderChild(props.children));

const toRaw = (result: unknown): RawHtml =>
  isRaw(result) ? result : raw(renderChild(result));

const renderElement = (
  type: unknown,
  props: Record<string, unknown> | null,
): RawHtml => {
  const p = props ?? {};
  if (type === Fragment) return raw(renderChild(p.children));

  if (typeof type === "function") return toRaw(type(p));

  const tag = String(type);
  const dsi = p.dangerouslySetInnerHTML as { __html?: string } | undefined;
  let attrs = "";
  let inner = "";
  for (const [key, value] of Object.entries(p))
    if (key === "children") {
      inner = renderChild(value);
    } else if (key === "dangerouslySetInnerHTML") {
      // Inline HTML is trusted; supplants any children.
      inner = dsi?.__html ?? "";
    } else if (typeof value !== "function") attrs += renderAttr(key, value);

  if (VOID_TAGS.has(tag) && p.children === undefined && dsi === undefined)
    return raw(`<${tag}${attrs}/>`);

  return raw(`<${tag}${attrs}>${inner}</${tag}>`);
};

const jsx = (type: unknown, props: Record<string, unknown> | null): RawHtml =>
  renderElement(type, props);

const jsxs = (type: unknown, props: Record<string, unknown> | null): RawHtml =>
  renderElement(type, props);

// Identity for callers that previously needed hono's renderToString: every JSX
// expression is already a fully-rendered HTML string.
const renderToString = (node: unknown): string => renderChild(node);

type Child =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | RawHtml
  | Child[];

type PropsWithChildren<T = object> = { children?: Child } & T;

export type { Child, PropsWithChildren, RawHtml };
export { Fragment, jsx, jsxs, raw, renderToString };

declare global {
  // biome-ignore lint/style/noNamespace: ambient JSX namespace is required to type permissive tsx intrinsic elements.
  namespace JSX {
    type Element = RawHtml;
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicElements {
      // biome-ignore lint/suspicious/noExplicitAny: htmx/data attrs are dynamic.
      [tag: string]: any;
    }
  }
}
