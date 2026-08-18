import { copyFileSync, linkSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Windows twin of type-a-bin's mockBin, which the harness uses on macOS and
// Linux to put a mocked binary on PATH. PATH interception needs a real
// executable there: Node refuses to spawn .cmd/.bat shims without a shell,
// and an extensionless #! script cannot execute at all. So each mock is a
// hard link of node.exe named <bin>.exe, and a preload (mock-bin-preload.mjs)
// registered through NODE_OPTIONS turns a spawn of that exe into the mock
// TypeScript script — argv, stdin, stdout, and exit codes all pass through.
const PRELOAD = join(
  dirname(fileURLToPath(import.meta.url)),
  "mock-bin-preload.mjs",
);
// tsx must be initialized with --import (its loader rejects module.register),
// the same way bin/glv-*.mjs loads it; the preload rides along as a second
// --import so the mock's .ts entry resolves through tsx's ESM hooks.
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const PRELOAD_FLAGS =
  `--import ${pathToFileURL(TSX_LOADER).href} ` +
  `--import ${pathToFileURL(PRELOAD).href}`;
const TARGETS_VAR = "GLV_MOCK_BIN_TARGETS";

const readTargets = (): Record<string, string> => {
  try {
    return JSON.parse(process.env[TARGETS_VAR] ?? "{}");
  } catch {
    return {};
  }
};

const restoreEnv = (name: string, previous: string | undefined): void => {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
};

const mockBinWindows = async (
  binName: string,
  file: string,
): Promise<() => void> => {
  const dir = await mkdtemp(join(tmpdir(), "glv-mock-bin-"));
  const exe = join(dir, `${binName}.exe`);
  try {
    linkSync(process.execPath, exe);
  } catch {
    // Different volume than the Node install: fall back to a real copy.
    copyFileSync(process.execPath, exe);
  }

  const prevPath = process.env.PATH;
  const prevNodeOptions = process.env.NODE_OPTIONS;
  const prevTargets = process.env[TARGETS_VAR];

  process.env.PATH = `${dir}${delimiter}${prevPath ?? ""}`;
  process.env.NODE_OPTIONS =
    prevNodeOptions === undefined || prevNodeOptions === ""
      ? PRELOAD_FLAGS
      : `${PRELOAD_FLAGS} ${prevNodeOptions}`;
  process.env[TARGETS_VAR] = JSON.stringify({
    ...readTargets(),
    [binName]: file,
  });

  return () => {
    restoreEnv("PATH", prevPath);
    restoreEnv("NODE_OPTIONS", prevNodeOptions);
    restoreEnv(TARGETS_VAR, prevTargets);
    // A shim exe that is still executing locks its file on Windows; retry,
    // then warn rather than throw — temp debris never justifies a failure.
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 40,
        retryDelay: 250,
      });
    } catch (err) {
      console.error(
        `warning: could not remove mock bin ${dir}: ${String(err)}`,
      );
    }
  };
};

export { mockBinWindows };
