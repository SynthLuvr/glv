const isExperimental = (warning: Error): boolean =>
  warning.name === "ExperimentalWarning";

// Node 26 installs its own internal `warning` listener that prints every
// warning through console.error — registering application listeners does
// not silence it. In `serve` that internal print lands after setupLogging
// has wrapped console with consola, so the badge renderer tags every
// warning as an ERROR:
//
//   [8:09:32 AM]  ERROR  (node:63571) ExperimentalWarning: ...
//
// The internal listener is therefore removed outright and this module
// becomes the printer: ExperimentalWarnings are dropped — they are
// informational feature-detection noise, exactly the class
// `node --disable-warning=ExperimentalWarning` exists for — and every
// other warning keeps Node's stack-bearing format via a raw stderr write
// that bypasses consola and its level tagging entirely.
//
// Import-order contract: @simplewebauthn/server constructs its
// SettingsService at module scope, which probes the experimental
// SubtleCrypto.supports("verify", "ML-DSA-44") on Node 26 and emits both
// warnings above. The probe runs during import evaluation, so this file
// must evaluate before that package does: auth/service.ts imports it as
// its first import, and ESM evaluates imports depth-first in declaration
// order, which guarantees the filter is installed before the WebAuthn
// package runs in every process that pulls auth in (both flavors' serve,
// CLIs, and integration tests).
process.removeAllListeners("warning");
process.on("warning", (warning: Error): void => {
  if (isExperimental(warning)) return;
  process.stderr.write(
    `${warning.stack ?? `${warning.name}: ${warning.message}`}\n`,
  );
});
