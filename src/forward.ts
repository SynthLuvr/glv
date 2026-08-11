import { execa } from "execa";

// ssh -R reverse tunnel: the remote bind forwards back to the local viewer
// on the same port, so a request to the remote viewer port reaches here.
//
// Requires the `ssh` binary on PATH (OpenSSH client). On Linux/macOS it ships
// with the OS; on Windows 10/11 it is an optional "OpenSSH Client" component
// (Settings > Apps > Optional features). --forward is opt-in, so a missing ssh
// is surfaced as an execa ENOENT when the flag is used, not at startup.
const forwardArgs = (port: number, host: string): readonly string[] => [
  "-NT",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ExitOnForwardFailure=yes",
  "-R",
  `127.0.0.1:${port}:127.0.0.1:${port}`,
  host,
];

type TunnelHandle = {
  kill: () => void;
};

// kill() is idempotent and synchronous, so it is safe to call from a process
// "exit" handler.
const startForwardTunnel = (port: number, host: string): TunnelHandle => {
  const proc = execa("ssh", [...forwardArgs(port, host)], {
    stdio: "inherit",
  });
  let killed = false;
  // ExitOnForwardFailure makes ssh exit non-zero if the remote bind fails;
  // surface that so the operator knows the tunnel never came up.
  void proc.then(
    () => {
      if (!killed) console.error("ssh reverse tunnel closed");
    },
    (err: unknown) => {
      if (!killed) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`ssh reverse tunnel error: ${msg}`);
      }
    },
  );
  console.log(`ssh reverse tunnel → ${host}:${port} (remote → local)`);
  const kill = (): void => {
    if (killed) return;
    killed = true;
    proc.kill("SIGTERM");
  };
  return { kill };
};

export type { TunnelHandle };
export { startForwardTunnel };
