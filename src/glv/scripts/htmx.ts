type HtmxAjaxOptions = {
  target: string | Element;
  swap: string;
  values?: Record<string, string>;
};

// The slice of htmx's global API and event surface these scripts touch.
// htmx loads as a classic script, so it is read off the global and
// runtime-guarded rather than imported.
type HtmxApi = {
  ajax: (verb: string, path: string, options: HtmxAjaxOptions) => void;
  trigger: (elt: Element, eventName: string) => void;
  config: {
    responseHandling: Array<{ code: string; swap: boolean; error?: boolean }>;
  };
};

const isHtmxApi = (value: unknown): value is HtmxApi => {
  if (typeof value !== "object" || value === null) return false;
  const { ajax, trigger, config } = value as Record<string, unknown>;
  return (
    typeof ajax === "function" &&
    typeof trigger === "function" &&
    typeof config === "object" &&
    config !== null
  );
};

// The htmx global, when the classic script has loaded.
const getHtmx = (): HtmxApi | undefined => {
  const { htmx } = globalThis as { htmx?: unknown };
  return isHtmxApi(htmx) ? htmx : undefined;
};

// htmx swap lifecycle events (beforeSwap, afterSwap, oobAfterSwap) carry
// the swap's target element in their detail; null when the event is not
// shaped like a swap event.
const htmxSwapTarget = (e: Event): Element | null => {
  if (!(e instanceof CustomEvent)) return null;
  const detail = e.detail as { target?: unknown } | null | undefined;
  return detail?.target instanceof Element ? detail.target : null;
};

// The slice of htmx:afterRequest's detail consumers read: which path the
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

export { getHtmx, htmxRequestDetail, htmxSwapTarget };
