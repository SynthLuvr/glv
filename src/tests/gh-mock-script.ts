const args = process.argv.slice(2);

// Stand-in for the real GitHub CLI. Driven by the PR number embedded in the
// URL so a single server instance can exercise multiple states/branches
// without reconfiguration. Responses mirror the JSON that `gh pr view
// <url> --json <field>` would emit.

const jsonIdx = args.indexOf("--json");
const field = jsonIdx >= 0 ? (args[jsonIdx + 1] ?? "") : "";

const url = args.find((a) => a.startsWith("https://")) ?? "";
const prMatch = /\/pull\/(\d+)/.exec(url);
const prNum = prMatch !== null ? Number(prMatch[1]) : 0;

// Deterministic state by PR number so one server covers all three states.
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
