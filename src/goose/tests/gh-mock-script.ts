const args = process.argv.slice(2);

// Mocked `gh pr view`: the PR number in the URL selects the response so one
// server instance can exercise every state/branch without reconfiguration.
const jsonIdx = args.indexOf("--json");
const field = jsonIdx >= 0 ? (args[jsonIdx + 1] ?? "") : "";

const url = args.find((a) => a.startsWith("https://")) ?? "";
const prNum = Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

const STATE_BY_NUM: Record<number, string> = {
  201: "OPEN",
  202: "MERGED",
  203: "CLOSED",
};

const main = (): void => {
  if (field === "state") {
    const state = STATE_BY_NUM[prNum] ?? "OPEN";
    process.stdout.write(JSON.stringify({ state }));
  } else if (field === "headRefName") {
    const branch = prNum > 0 ? `feat-${prNum}` : "main";
    process.stdout.write(JSON.stringify({ headRefName: branch }));
  }
  process.exit(0);
};

main();

export {};
