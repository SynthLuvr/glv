import { execa } from "execa";

// ssh -R reverse tunnel: the remote bind forwards back to the local viewer
// on the same port, so a request to the remote viewer port reaches here.
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
