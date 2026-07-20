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

export type { ExecOptions, ExecResult };
export { execGh, execGit };
