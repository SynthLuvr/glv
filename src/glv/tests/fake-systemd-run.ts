import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

// A stand-in for the real systemd-run (#392's integration suite): every
// invocation appends its argv as one JSON line to the path in
// GLV_FAKE_SYSTEMD_RUN_LOG, then runs the command after "--" in this
// process's own process group — the same shape real `systemd-run --user
// --scope` gives: the agent shares the caller's group (so glv's group
// kill on stop/settle still reaches the whole tree, #379) and the
// caller's stdio (so the prompt over stdin and NDJSON over stdout keep
// flowing). Signals are forwarded to the child, and the child's exit
// code — or signal death — is propagated.
const args = process.argv.slice(2);

const logPath = process.env.GLV_FAKE_SYSTEMD_RUN_LOG;
if (logPath !== undefined && logPath !== "")
  appendFileSync(logPath, `${JSON.stringify(args)}\n`);

const separator = args.indexOf("--");
const command = separator >= 0 ? args.slice(separator + 1) : [];
if (command.length === 0) process.exit(0);

const child = spawn(command[0], command.slice(1), { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    child.kill(signal);
  });
child.on("exit", (code, signal) => {
  if (signal === null) {
    process.exit(code ?? 0);
    return;
  }
  // Die by the same signal: drop the forwarders first so it lands.
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.kill(process.pid, signal);
});
