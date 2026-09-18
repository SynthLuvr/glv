type HtmxAjaxOptions = {
  target: string | Element;
  swap: string;
  values?: Record<string, string>;
};

// The slice of htmx's global API and event surface these scripts touch,
// declared once instead of as per-file ambient blocks and ad-hoc casts,
// so every script agrees on the shape. htmx is loaded as a classic
// script by the layout, so it is read off the global and runtime-guarded
// — there is no module import to lean on. Pure types and guards: no
// arktype here, because DOM event details carry Element instances,
// which schemas cannot express — the runtime check is the instanceof
// narrow below.
type HtmxApi = {
  ajax: (verb: string, path: string, options: HtmxAjaxOptions) => void;
  trigger: (elt: Element, eventName: string) => void;
  config: {
    responseHandling: Array<{ code: string; swap: boolean; error?: boolean }>;
  };
};

const isHtmxApi = (value: unknown): value is HtmxApi =>
  typeof value === "object" &&
  value !== null &&
  "ajax" in value &&
  typeof value.ajax === "function" &&
  "trigger" in value &&
  typeof value.trigger === "function" &&
  "config" in value &&
  typeof (value as { config: unknown }).config === "object" &&
  (value as { config: unknown }).config !== null;

// The htmx global, when the classic script has loaded.
const getHtmx = (): HtmxApi | undefined => {
  const { htmx } = globalThis as { htmx?: unknown };
  return isHtmxApi(htmx) ? htmx : undefined;
};

// htmx dispatches its swap lifecycle (beforeSwap, afterSwap,
// oobAfterSwap) as CustomEvents whose detail carries the swap's target
// element. This is the one field glv reads; null when the event is not
// shaped like a swap event (or the target is not an Element).
const htmxSwapTarget = (e: Event): Element | null => {
  if (!(e instanceof CustomEvent)) return null;
  const detail = e.detail as { target?: unknown } | null | undefined;
  return detail?.target instanceof Element ? detail.target : null;
};

// The detail slice of htmx:afterRequest consumers read: which path the
// finished request hit and whether it succeeded.
type HtmxRequestDetail = {
  requestConfig?: { path?: string };
  successful?: boolean;
};

const htmxRequestDetail = (e: Event): HtmxRequestDetail => {
  if (!(e instanceof CustomEvent)) return {};
  const detail = e.detail as Partial<HtmxRequestDetail> | null | undefined;
  return detail === null || typeof detail !== "object" ? {} : detail;
};

export type { HtmxApi, HtmxRequestDetail };
export { getHtmx, htmxRequestDetail, htmxSwapTarget };
