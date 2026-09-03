const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// Reads an environment variable as a positive number, falling back when
// it is unset, empty, or not a positive finite value. Used for
// test-facing overrides of timing defaults.
const positiveEnvNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export { errorMessage, positiveEnvNumber };
