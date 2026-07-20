import { execa } from "execa";

type ExecOptions = { cwd?: string; timeoutMs?: number };

type ExecResult = { stdout: string; stderr: string; exitCode: number };

// `reject: false` turns a non-zero exit into a result rather than a throw; a
// missing binary or a thrown timeout still rejects, so each caller decides how
// to degrade (throw, return `{}` , fall back to a default).
const execGit = async (
  args: readonly string[],
  { cwd, timeoutMs }: ExecOptions = {},
): Promise<ExecResult> => {
  const result = await execa("git", [...args], {
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

const execGh = async (
  args: readonly string[],
  { timeoutMs }: ExecOptions = {},
): Promise<ExecResult> => {
  const result = await execa("gh", [...args], {
    reject: false,
    timeout: timeoutMs,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  };
};

export type { ExecOptions, ExecResult };
export { execGh, execGit };
