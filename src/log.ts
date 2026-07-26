import { createConsola } from "consola";

const isDebugEnabled = (): boolean =>
  process.env.GLV_DEBUG === "1" || process.env.GLV_DEBUG === "true";

// Mirrors ../mynth-logger's dev setup: one consola instance wraps the global
// console so every console.warn/debug/error is rendered with the colorful
// fancy reporter in the terminal. Debug output stays gated behind GLV_DEBUG
// (matching the previous logger) by lowering the level otherwise; production
// concerns (JSON logs, redaction, Datadog/Discord forwarding) are deferred.
// consola's bundled types omit the runtime-supported "fancy" flag, so the
// options are built as a plain object before being passed in.
const setupLogging = () => {
  const options = {
    fancy: true,
    level: isDebugEnabled() ? 5 : 3,
  };
  const consola = createConsola(options);
  consola.wrapConsole();
  return consola;
};

export { setupLogging };
