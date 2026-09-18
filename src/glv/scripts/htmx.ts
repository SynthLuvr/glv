import { type } from "arktype";

type HtmxAjaxOptions = {
  target: string | Element;
  swap: string;
  values?: Record<string, string>;
};

// The slice of htmx's global API and event surface these scripts touch.
// htmx loads as a classic script, so it is read off the global and
// runtime-validated rather than imported. Call signatures are checked
// only as far as the runtime can see (function-ness); every data shape
// — config.responseHandling included — is validated by the schema.
type HtmxApi = {
  ajax: (verb: string, path: string, options: HtmxAjaxOptions) => void;
  trigger: (elt: Element, eventName: string) => void;
  config: {
    responseHandling: Array<{ code: string; swap: boolean; error?: boolean }>;
  };
};

const HtmxApiSchema = type({
  ajax: "Function",
  trigger: "Function",
  config: {
    responseHandling: [
      { code: "string", swap: "boolean", "error?": "boolean" },
      "[]",
    ],
  },
});

const isHtmxApi = (value: unknown): value is HtmxApi =>
  !(HtmxApiSchema(value) instanceof type.errors);

// The htmx global, when the classic script has loaded and validates.
const getHtmx = (): HtmxApi | undefined => {
  const candidate: unknown = Reflect.get(globalThis, "htmx");
  return isHtmxApi(candidate) ? candidate : undefined;
};

// htmx swap lifecycle events (beforeSwap, afterSwap, oobAfterSwap) carry
// the swap's target element in their detail; null when the event is not
// shaped like a swap event.
const htmxSwapTarget = (e: Event): Element | null => {
  if (!(e instanceof CustomEvent)) return null;
  const target: unknown = e.detail?.target;
  return target instanceof Element ? target : null;
};

// The slice of htmx:afterRequest's detail consumers read: which path the
// finished request hit and whether it succeeded. A detail missing or
// failing the schema yields no fields, so consumers see a neutral "no
// information" instead of trusting unknown shapes.
const HtmxRequestDetailSchema = type({
  "requestConfig?": { "path?": "string" },
  "successful?": "boolean",
});

type HtmxRequestDetail = typeof HtmxRequestDetailSchema.infer;

const htmxRequestDetail = (e: Event): HtmxRequestDetail => {
  if (!(e instanceof CustomEvent)) return {};
  const detail = HtmxRequestDetailSchema(e.detail);
  return detail instanceof type.errors ? {} : detail;
};

export { getHtmx, htmxRequestDetail, htmxSwapTarget };
