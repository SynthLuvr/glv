import { execa } from "execa";

// Reverse tunnel: on the remote host, bind 127.0.0.1:<port> and forward it
// back to the local viewer on 127.0.0.1:<port>. Both sides use the serve
// port so a remote hit on the viewer port reaches the local server.
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

// Starts a long-lived `ssh -NT` reverse tunnel. The handle's kill() is
// idempotent and synchronous so it is safe from a process "exit" handler.
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
export { forwardArgs, startForwardTunnel };
