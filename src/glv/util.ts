const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// `unref` keeps a pending timer (interval or timeout) from blocking
// process exit; guarded because the global timer types may resolve to
// numbers under DOM libs.
const unrefTimer = (timer: ReturnType<typeof setTimeout>): void => {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  )
    timer.unref();
};

// Reads an environment variable as a positive number, falling back when
// it is unset, empty, or not a positive finite value. Used for
// test-facing overrides of timing defaults.
const positiveEnvNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export { errorMessage, positiveEnvNumber, unrefTimer };
