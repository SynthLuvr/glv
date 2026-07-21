import { execa } from "execa";

type ExecOptions = { cwd?: string; timeoutMs?: number };

type ExecResult = { stdout: string; stderr: string; exitCode: number };

// `reject: false` makes a non-zero exit a result rather than a throw; a missing
// binary or a thrown timeout still rejects, so each caller decides how to
// degrade (throw, fall back to a default, etc.).
const runBinary = async (
  binary: string,
  args: readonly string[],
  { cwd, timeoutMs }: ExecOptions = {},
): Promise<ExecResult> => {
  const result = await execa(binary, [...args], {
    cwd,
    reject: false,
    timeout: timeoutMs,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
};

const execGit = (
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> => runBinary("git", args, options);

const execGh = (
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> => runBinary("gh", args, options);

// Throws on a non-zero exit (a genuine `gh` failure) so callers that need
// hard failure rather than graceful degradation share one path. A missing
// binary or a timeout still rejects inside `execGh`: `reject:false` only
// swallows non-zero exits, not spawn failures or timeouts.
const execGhOrThrow = async (
  args: readonly string[],
  options: ExecOptions = {},
): Promise<string> => {
  const result = await execGh(args, options);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `gh ${args.join(" ")} failed`);
  return result.stdout;
};

export type { ExecOptions, ExecResult };
export { execGh, execGhOrThrow, execGit };
