const printWarning = (warning: Error): void => {
  if (warning.name === "ExperimentalWarning") return;
  process.stderr.write(
    `${warning.stack ?? `${warning.name}: ${warning.message}`}\n`,
  );
};

// Node 26 prints every warning through an internal `warning` listener —
// registering application listeners does not silence it. In `serve` that
// print lands after setupLogging has wrapped console with consola, so
// warnings render as ERROR badges. Replace the internal printer with our
// own: ExperimentalWarning is dropped (feature-detection noise —
// @simplewebauthn/server probes experimental WebCrypto at import time),
// everything else keeps Node's stack-bearing format through a raw stderr
// write that bypasses consola's level tagging.
//
// The probes above fire while @simplewebauthn/server evaluates, so this
// module must evaluate before it; see the guarded import in auth/service.ts.
process.removeAllListeners("warning");
process.on("warning", printWarning);
