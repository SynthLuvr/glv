import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { type } from "arktype";
import { execa } from "execa";
import { tryParseJson } from "./parse.js";
import { execGit } from "./shell.js";

type Materialiser = (
  owner: string,
  repo: string,
  branch: string,
  path: string,
) => Promise<void>;

const stderrGist = (stderr: unknown): string =>
  typeof stderr === "string" ? stderr.trim().slice(-300) : "";

// No safe fallback for a missing sshUrl, so surface a structured error
// rather than degrade silently.
const SshUrlView = type({ "sshUrl?": "unknown" });

const parseSshUrl = (stdout: string): string => {
  const tail = stdout.trim().slice(-200);
  const parsed = tryParseJson(stdout);
  if (parsed === null)
    throw new Error(`gh repo view printed non-JSON output: "${tail}"`);
  const view = SshUrlView(parsed);
  if (view instanceof type.errors)
    throw new Error(`gh repo view printed non-JSON output: "${tail}"`);
  const { sshUrl } = view;
  if (typeof sshUrl !== "string" || sshUrl === "")
    throw new Error(`gh repo view did not return an sshUrl: "${tail}"`);
  return sshUrl;
};

const getSshUrl = async (owner: string, repo: string): Promise<string> => {
  const { stdout } = await execa("gh", [
    "repo",
    "view",
    `${owner}/${repo}`,
    "--json",
    "sshUrl",
  ]);
  return parseSshUrl(stdout);
};

const runGit = async (
  args: string[],
  failure: string,
  cwd?: string,
): Promise<void> => {
  const { stderr, exitCode } = await execGit(args, { cwd });
  if (exitCode !== 0) throw new Error(stderrGist(stderr) || failure);
};

// --single-branch keeps the clone cheap. The URL is passed in (rather than
// resolved via gh) so this can run against a local repo in tests.
const runClone = async (
  url: string,
  branch: string,
  path: string,
): Promise<void> => {
  await runGit(
    ["clone", "--branch", branch, "--single-branch", url, path],
    `git clone failed for ${branch}`,
  );
};

// A --single-branch clone tracks only one ref, so fetch the target branch
// explicitly and reset onto FETCH_HEAD. A plain checkout would fail for any
// branch the clone never fetched.
const runUpdate = async (path: string, branch: string): Promise<void> => {
  await runGit(["fetch", "origin", branch], "git fetch failed", path);
  await runGit(
    ["checkout", "-B", branch, "FETCH_HEAD"],
    "git checkout failed",
    path,
  );
};

const materialise = async (
  owner: string,
  repo: string,
  branch: string,
  path: string,
): Promise<void> => {
  if (existsSync(path)) {
    await runUpdate(path, branch);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const url = await getSshUrl(owner, repo);
  await runClone(url, branch, path);
};

export type { Materialiser };
export { materialise };
