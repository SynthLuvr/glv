import { createRequire } from "node:module";

// Load @kitajs/html's escape/attribute helpers at runtime without a typed
// import. A static `import ... from "@kitajs/html"` pulls in the package's
// `jsx.d.ts`, which declares a global `JSX` namespace that would override
// this project's permissive JSX types. `require()` returns the module
// untyped, so those declaration files (and their global JSX namespace) never
// load, yet the real functions still resolve at runtime.
const { attributesToString, escapeHtml, isVoidElement } = createRequire(
  import.meta.url,
)("@kitajs/html") as {
  attributesToString: (attributes: object) => string;
  escapeHtml: (value: unknown) => string;
  isVoidElement: (tag: string) => boolean;
};

// A string already known to be safe HTML; rendered verbatim, never escaped.
type RawHtml = { readonly __raw: true; readonly html: string };

const raw = (html: string): RawHtml => ({ __raw: true, html });

const isRaw = (value: unknown): value is RawHtml =>
  typeof value === "object" &&
  value !== null &&
  (value as { __raw?: boolean }).__raw === true;

// Renders one child: plain strings are HTML-escaped (the security model this
// viewer relies on), while `raw()`-wrapped HTML passes through untouched.
// Element rendering, attribute serialisation, void-tag detection and the
// escape table itself are delegated to @kitajs/html rather than reimplemented.
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
  const dsi = (p.dangerouslySetInnerHTML as { __html?: string } | undefined)
    ?.__html;

  // Event handlers and the reserved children/innerHTML keys have no attribute
  // form; everything else is serialised by @kitajs/html.
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p))
    if (
      key !== "children" &&
      key !== "dangerouslySetInnerHTML" &&
      typeof value !== "function"
    )
      attrs[key] = value;

  const attrStr = attributesToString(attrs);
  const inner = dsi ?? renderChild(p.children);

  if (isVoidElement(tag) && p.children === undefined && dsi === undefined)
    return raw(`<${tag}${attrStr}/>`);

  return raw(`<${tag}${attrStr}>${inner}</${tag}>`);
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
