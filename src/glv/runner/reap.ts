import { unrefTimer } from "../util.js";

// Post-settle reaping for the execa subprocesses glv spawns with
// `killDescendants: true` — the runner's agent processes, the
// suggestions ask, the goose ACP catalogue probe.
//
// execa's killDescendants logic only runs inside subprocess.kill(), so
// when glv itself kills the process (a manual stop, the escalation
// ladder, the startup watchdog) the whole tree is torn down — but when
// the process dies on its own (crash exit, signal death, a kernel OOM
// kill) its descendants (MCP servers, tool-spawned background jobs) are
// re-parented to init while staying in glv's own process group, and
// under systemd in glv.service's cgroup. Nothing signals that group
// again: the descendants leak, unowned and unaccounted, for as long as
// they live (#379).
//
// The group itself survives the leader: killDescendants spawns the
// subprocess as its own process-group leader, and a pid stays reserved
// as a group id while any member lives, so signalling the group after
// the leader settled is safe and useful — execa's kill() routes
// process.kill(-pid) there and reports whether the signal reached
// anyone. One SIGTERM per settle, for every settle reason, makes
// descendants unable to outlive their run; an agent that genuinely
// wants a deliberate daemon can still setsid its way out, visibly.
//
// execa no-ops the call on Windows (no process groups; a pid is only
// reserved while a handle is open, which closes at exit), so that
// platform keeps its current behaviour: leaks there are covered only by
// the cleanup-on-parent-exit path. Documented limitation, shared with
// execa's own forceKillAfterDelay: once a group emptied, the OS may
// re-assign its pid to a new process-group leader, and a sweep landing
// in that window would signal the unrelated group — unlikely, and the
// same primitive every existing kill path already accepts.

// Matches execa's forceKillAfterDelay default and the runner's stop
// grace: a descendant that traps SIGTERM is SIGKILLed one window later.
// execa's own escalation cannot serve here — its abort controller fires
// when the subprocess settles, just before this sweep runs.
const REAP_GRACE_MS = 5000;

// The structural slice of an execa subprocess the reaper needs: a
// kill() that reaches the whole process group and reports whether the
// signal reached anyone.
type Reapable = {
  readonly kill: (signal?: NodeJS.Signals) => boolean;
};

// One group-targeted signal. execa reports an already-gone group as
// false rather than throwing; the try/catch guards anything else,
// because a throw inside a promise handler would surface as an
// unhandled rejection, which the server treats as fatal.
const signalGroup = (proc: Reapable, signal: NodeJS.Signals): boolean => {
  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
};

// Reaps the descendants of a subprocess that has settled, whatever the
// settle reason: SIGTERM to the group now, SIGKILL after the grace
// window if anyone trapped it. No-op once the group is gone.
const reapDescendants = (proc: Reapable): void => {
  if (!signalGroup(proc, "SIGTERM")) return;
  const timer = setTimeout(() => {
    signalGroup(proc, "SIGKILL");
  }, REAP_GRACE_MS);
  unrefTimer(timer);
};

// Attaches the reap to a subprocess's settlement. Call once, right
// after spawn. Both handlers matter: the rejection path (a crash exit)
// is the very leak this exists for.
const reapDescendantsOnSettle = <T>(proc: PromiseLike<T> & Reapable): void => {
  void proc.then(
    () => reapDescendants(proc),
    () => reapDescendants(proc),
  );
};

export { reapDescendantsOnSettle };
