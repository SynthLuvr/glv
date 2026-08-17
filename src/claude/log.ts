import { createConsola, LogLevels } from "consola";

// Wraps the global console with consola so diagnostics share one renderer.
// Debug output is hidden unless --debug or GLV_DEBUG enables it; warn and
// above always emit so production leaves a diagnostic trail.
const setupLogging = (debug: boolean): void => {
  const enableDebug =
    debug || process.env.GLV_DEBUG === "1" || process.env.GLV_DEBUG === "true";
  // Bundler resolution selects consola's browser types, whose createConsola
  // signature omits the runtime-supported `fancy` flag. Indirecting the
  // options through a variable sidesteps the excess-property check.
  const options = {
    fancy: true,
    level: enableDebug ? LogLevels.debug : LogLevels.info,
  };
  createConsola(options).wrapConsole();
};

export { setupLogging };
