import { createConsola, LogLevels } from "consola";

const isDebugEnabled = (debug: boolean): boolean =>
  debug || process.env.GLV_DEBUG === "1" || process.env.GLV_DEBUG === "true";

// Wraps the global console with consola so diagnostics share one renderer.
// Debug output stays hidden unless GLV_DEBUG lifts the level; warn and above
// always emit, leaving a diagnostic trail even in production.
const setupLogging = (debug: boolean): void => {
  // Bundler resolution selects consola's browser types, whose createConsola
  // signature omits the runtime-supported `fancy` flag. Indirecting the
  // options through a variable sidesteps the excess-property check.
  const options = {
    fancy: true,
    level: isDebugEnabled(debug) ? LogLevels.debug : LogLevels.info,
  };
  createConsola(options).wrapConsole();
};

export { setupLogging };
