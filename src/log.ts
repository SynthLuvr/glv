const isDebugEnabled = (): boolean =>
  process.env.GLV_DEBUG === "1" || process.env.GLV_DEBUG === "true";

const describeUnserialisable = (detail: unknown): string => {
  if (detail === null || typeof detail !== "object")
    return "<unserialisable value>";
  const name = (detail as { constructor?: { name?: string } }).constructor
    ?.name;
  return typeof name === "string" && name !== ""
    ? `<${name}>`
    : "<unserialisable value>";
};

// Renders a diagnostic value to a single line. Plain objects (structured
// context like { message, sessionId }) are serialised to JSON so the full
// detail survives instead of collapsing to "[object Object]".
const formatDetail = (detail: unknown): string => {
  if (typeof detail === "string") return detail;
  if (detail instanceof Error) return detail.message;
  if (detail === undefined) return "undefined";
  try {
    return JSON.stringify(detail);
  } catch {
    return describeUnserialisable(detail);
  }
};

const formatLine = (
  level: "debug" | "warn",
  component: string,
  detail: unknown,
): string => `[glv:${component}] ${level}: ${formatDetail(detail)}`;

// Benign catches (a process that already exited, a non-repo git query): hidden
// unless GLV_DEBUG is set so they aren't noise, yet observable when triaging.
const debug = (component: string, detail: unknown): void => {
  if (!isDebugEnabled()) return;
  console.debug(formatLine("debug", component, detail));
};

// Genuinely unexpected failures (e.g. a corrupt DB row, a goose crash): always
// emitted so there is a diagnostic trail even in production. Pass a string, an
// Error, or a structured object { message, ...context }.
const warn = (component: string, detail: unknown): void => {
  console.warn(formatLine("warn", component, detail));
};

export { debug, warn };
