import { type } from "arktype";
import { mayFailAsync } from "ts-handling";
import { parseJson } from "./parse.js";
import { PR_URL } from "./pr.js";
import { execGh } from "./shell.js";

type PrState = "open" | "merged" | "closed" | "unknown";

type CommandResult = { stdout: string };

type CommandRunner = (args: readonly string[]) => Promise<CommandResult>;

const GH_TIMEOUT_MS = 8000;

const runGh = async (args: readonly string[]): Promise<CommandResult> => {
  const { stdout } = await execGh(args, { timeoutMs: GH_TIMEOUT_MS });
  return { stdout };
};

const GhStateView = type({ "state?": "string" });

// Judge by parsed state, not exit code: unauthed `gh` exits 0 but prints
// help text instead of JSON.
const parseGhState = (stdout: string): PrState => {
  const parsed = parseJson(stdout);
  if (!parsed.ok) return "unknown";
  const view = GhStateView(parsed.data);
  if (view instanceof type.errors) return "unknown";
  const { state } = view;
  if (state === "OPEN") return "open";
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "unknown";
};

const HeadRefView = type({ "headRefName?": "string" });

const parseGhBranch = (stdout: string): string | undefined => {
  const parsed = parseJson(stdout);
  if (!parsed.ok) return undefined;
  const view = HeadRefView(parsed.data);
  if (view instanceof type.errors) return undefined;
  return view.headRefName || undefined;
};

// The URL round-trips through a query string — guard before passing to `gh`.
const isPrUrl = (url: string): boolean =>
  PR_URL.test(url) || /\/pull\/new\/[\w./-]+$/.test(url);

const runPrView = async (
  url: string,
  field: string,
  run: CommandRunner = runGh,
): Promise<string> => {
  if (!isPrUrl(url)) return "";
  const result = await mayFailAsync(() =>
    run(["pr", "view", url, "--json", field]),
  );
  if (!result.ok) {
    console.debug("[glv:pr-state]", result.error);
    return "";
  }
  return result.data.stdout;
};

const resolvePrState = async (
  url: string,
  run: CommandRunner = runGh,
): Promise<PrState> => parseGhState(await runPrView(url, "state", run));

const resolvePrBranch = async (
  url: string,
  run: CommandRunner = runGh,
): Promise<string | undefined> =>
  parseGhBranch(await runPrView(url, "headRefName", run));

const STATE_LABEL: Record<Exclude<PrState, "unknown">, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export type { CommandRunner };
export { resolvePrBranch, resolvePrState, STATE_LABEL };
