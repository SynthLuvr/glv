import { execa } from "execa";

// Per-run memory ceilings (#392): without one, every run — and every
// descendant it spawns — lives in glv's own cgroup, so a ballooning run
// gets the whole service OOM-killed. Each invocation instead runs in its
// own transient `systemd-run --user --scope` unit with a configurable
// MemoryMax (and no swap): a breach kills only that run's scope, and the
// journal names `glv-run-<run-id>` for attribution. Scope mode keeps the
// command in the process group execa already created, so #379's group
// kill on stop/settle still reaches the whole tree.

// A configured ceiling: a byte budget for the scope, or explicitly off
// (the run shares glv's own cgroup).
type MemoryCeiling =
  | { readonly kind: "bytes"; readonly bytes: number }
  | { readonly kind: "off" };

const MEMORY_SPEC_ERROR =
  'The memory limit must be a size like "512M" or "8G" (K/M/G/T, or plain ' +
  'bytes), or "off".';

// "<digits>[.digits][unit]" where unit is K/M/G/T (1024 base, like
// systemd's own size parser), optionally suffixed i/B; "off", "none",
// and "0" disable the ceiling.
const MEMORY_SPEC_RE = /^(\d+(?:\.\d+)?)\s*(k|m|g|t)i?b?$/i;
const PLAIN_BYTES_RE = /^(\d+(?:\.\d+)?)\s*b?$/i;
const OFF_SPECS = new Set(["off", "none", "0"]);

// The 1024-base multipliers a unit letter names, largest first.
const UNIT_MULTIPLIERS: ReadonlyArray<readonly [string, number]> = [
  ["t", 1024 ** 4],
  ["g", 1024 ** 3],
  ["m", 1024 ** 2],
  ["k", 1024],
];

const multiplierOf = (unit: string): number =>
  UNIT_MULTIPLIERS.find(([letter]) => letter === unit)?.[1] ?? 1;

// Parses one memory-limit spec; undefined (not a throw) when the spec is
// malformed, so the config builder and the request validators can each
// answer with their own context.
const parseMemoryCeiling = (spec: string): MemoryCeiling | undefined => {
  const trimmed = spec.trim();
  if (OFF_SPECS.has(trimmed.toLowerCase())) return { kind: "off" };
  const match = MEMORY_SPEC_RE.exec(trimmed) ?? PLAIN_BYTES_RE.exec(trimmed);
  if (match === null) return undefined;
  const bytes = Math.round(
    Number(match[1]) * multiplierOf((match[2] ?? "").toLowerCase()),
  );
  return bytes >= 1 ? { kind: "bytes", bytes } : undefined;
};

// Renders bytes back in systemd's own spelling (largest unit that divides
// exactly, plain bytes otherwise) so the scope argv stays human-readable.
const renderMemorySpec = (bytes: number): string => {
  for (const [unit, multiplier] of UNIT_MULTIPLIERS)
    if (bytes >= multiplier && bytes % multiplier === 0)
      return `${bytes / multiplier}${unit.toUpperCase()}`;
  return String(bytes);
};

// The prefix every run scope's unit name carries; the run id is a
// per-invocation UUID, so units never collide.
const RUN_SCOPE_PREFIX = "glv-run-";

// One resolved scope for an invocation.
type RunScope = { readonly unit: string; readonly bytes: number };

// The argv systemd-run receives. --scope keeps glv's own stdio (the
// prompt over stdin, NDJSON over stdout) flowing straight through to the
// agent; MemorySwapMax=0 makes MemoryMax a hard ceiling; no --collect,
// so a breached scope leaves its oom-kill record in the journal.
const scopeLaunch = (
  scope: RunScope,
  binary: string,
  args: readonly string[],
): { binary: string; args: string[] } => ({
  binary: "systemd-run",
  args: [
    "--user",
    "--scope",
    "--quiet",
    `--unit=${scope.unit}`,
    "-p",
    `MemoryMax=${renderMemorySpec(scope.bytes)}`,
    "-p",
    "MemorySwapMax=0",
    "--",
    binary,
    ...args,
  ],
});

// Probes the real mechanism once and caches the answer for the process
// lifetime: a shimmed systemd-run on PATH (the integration suite)
// answers as readily as a live user manager. Non-Linux platforms have
// no systemd at all.
let scopeProbe: Promise<boolean> | undefined;

const systemdUserScopeAvailable = (): Promise<boolean> => {
  if (process.platform !== "linux") return Promise.resolve(false);
  scopeProbe ??= execa(
    "systemd-run",
    ["--user", "--scope", "--quiet", "--", "true"],
    { timeout: 5000, reject: false },
  )
    .then((result) => result.exitCode === 0)
    .catch(() => false);
  return scopeProbe;
};

// Fallback diagnostics, logged once per process so a long-lived serve
// names its reason without spamming every run.
const warned = new Set<string>();

const warnOnce = (key: string, message: string): void => {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
};

// Resolves the scope for one invocation. An off ceiling, or a configured
// one on a host with no usable user systemd, degrades to a direct spawn
// with a logged warning (#392 acceptance).
const planRunScope = async (
  ceiling: MemoryCeiling,
  runId: string | undefined,
): Promise<RunScope | undefined> => {
  if (ceiling.kind === "off") {
    warnOnce(
      "disabled",
      "run: per-run memory ceiling is disabled — every run shares the " +
        "server's own cgroup, so one ballooning run can OOM-kill the " +
        "whole service (#392)",
    );
    return undefined;
  }
  if (runId === undefined) return undefined;
  if (!(await systemdUserScopeAvailable())) {
    warnOnce(
      "unavailable",
      "run: per-run memory ceiling is configured but systemd-run --user " +
        "is unavailable — spawning runs without their own scope (#392)",
    );
    return undefined;
  }
  return { unit: `${RUN_SCOPE_PREFIX}${runId}`, bytes: ceiling.bytes };
};

export type { MemoryCeiling };
export {
  MEMORY_SPEC_ERROR,
  parseMemoryCeiling,
  planRunScope,
  RUN_SCOPE_PREFIX,
  scopeLaunch,
};
