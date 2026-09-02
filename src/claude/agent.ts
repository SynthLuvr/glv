import type { AgentInvocation } from "../glv/runner/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../glv/system.js";
import { claudeProfile } from "./profile.js";

// DESIGN DECISION: the default is "inherit", which passes no
// --permission-mode flag, so claude applies permissions.defaultMode from
// ~/.claude/settings.json and glv-launched runs behave like terminal
// sessions. Any other mode is passed as the flag and silently OVERRIDES
// that setting (verified against claude 2.1.232); headless --print runs
// cannot show permission prompts, so under "manual" a tool call needing
// approval is denied outright. bypassPermissions grants full agency; see
// the security note in the README before pinning it. ("plan" is excluded:
// in --print mode it returns a plan instead of acting.)
const DEFAULT_PERMISSION_MODE = "inherit";
const PERMISSION_MODES: readonly string[] = [
  "inherit",
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
  "manual",
];

// claude reads the prompt from stdin when `--print` is given no positional
// prompt — this sidesteps the OS argument-length limit and all shell-quoting
// concerns, and works for arbitrarily long prompts. `--verbose` is required
// for stream-json to emit the full event stream rather than just the final
// result record.
const STREAM_FLAGS = ["--print", "--output-format", "stream-json", "--verbose"];

// DESIGN DECISION (verified empirically against claude 2.1.233,
// 2026-09-02): `--input-format stream-json` makes claude accept user
// messages as NDJSON lines on a long-lived stdin. The first line starts a
// turn immediately while stdin stays open; further lines are processed as
// subsequent turns in the same process and session (each emitting its own
// system/init + assistant messages + one terminal {"type":"result"}
// record); on stdin EOF claude finishes its queue and exits 0. Steered
// messages are persisted into the session transcript, so GLV's transcript
// reader picks them up with zero changes. Upstream support is longstanding
// (changelog v0.2.108) — a message arriving mid-turn is queued by claude
// and starts a new turn, so worst case steering degrades to a turn
// boundary, never a lost prompt.
const STEER_INPUT_FLAGS = ["--input-format", "stream-json"];

// DESIGN DECISION: --append-system-prompt is passed on every invocation,
// including resume (--resume) sessions — not just the first prompt of a
// new session. It is a per-invocation runtime injection that claude does
// NOT persist into the stored conversation. This was verified empirically
// against claude 2.1.232:
//
//   1. New session + --append-system-prompt "reply BANANA only" → "BANANA" ✓
//   2. Resume WITHOUT the flag                          → "6" (persona lost) ✗
//   3. Resume WITH the flag                             → "BANANA" ✓
//
// The token cost is negligible: ~240 tokens (156 words) vs. the
// 10K–100K+ tokens of a typical resumed conversation — well under 1%
// overhead.
//
// --append-system-prompt is used rather than --system-prompt because the
// latter REPLACES claude's built-in system prompt, stripping out the tool
// instructions the coding agent depends on.
//
// The only alternative that would avoid per-invocation passing is setting
// the prompt at the claude config level (~/.claude/settings.json), but that
// affects ALL claude usage system-wide, not just GLV-managed sessions.
const SYSTEM_FLAGS = ["--append-system-prompt", DEFAULT_SYSTEM_PROMPT];

const permissionFlags = (mode: string): string[] =>
  mode === "inherit" ? [] : ["--permission-mode", mode];

// glv pre-assigns the session id (verified: claude 2.1.232 honours
// --session-id and names the transcript <uuid>.jsonl accordingly), so the
// runner's handle key is forwarded to the binary and the id is known before
// the process even starts.
const makeClaudeAgent = (
  binary: string,
  permissionMode: string = DEFAULT_PERMISSION_MODE,
  steering: boolean = true,
): AgentInvocation => {
  if (!PERMISSION_MODES.includes(permissionMode))
    throw new Error(
      `Invalid permission mode "${permissionMode}": must be one of ${PERMISSION_MODES.join(", ")}`,
    );
  // The streaming-input flags and the steer spec go together: without them
  // the prompt travels as raw write-and-close stdin (the pre-steering
  // contract) and GLV_DISABLE_STEERING restores exactly that behaviour.
  const steerFlags = steering ? STEER_INPUT_FLAGS : [];
  return {
    name: claudeProfile.agentName,
    binary,
    newSession: (_prompt, key) => [
      "--session-id",
      key,
      ...SYSTEM_FLAGS,
      ...permissionFlags(permissionMode),
      ...STREAM_FLAGS,
      ...steerFlags,
    ],
    resume: (key) => [
      "--resume",
      key,
      ...SYSTEM_FLAGS,
      ...permissionFlags(permissionMode),
      ...STREAM_FLAGS,
      ...steerFlags,
    ],
    // claude gates a directory it has never seen behind an interactive "do
    // you trust the files in this folder?" dialog that a headless --print run
    // can never answer, and drops project-scoped settings until it is
    // accepted; CLAUDE_CODE_SANDBOXED short-circuits both to trusted. It only
    // marks the directory trusted — what claude may do there is still bounded
    // by the permission mode.
    env: () => ({ CLAUDE_CODE_SANDBOXED: "1" }),
    steer: steering
      ? {
          inputFlags: STEER_INPUT_FLAGS,
          encode: (p) =>
            JSON.stringify({
              type: "user",
              message: { role: "user", content: p },
            }),
          isTurnEnd: (line) => {
            try {
              return (JSON.parse(line) as { type?: unknown }).type === "result";
            } catch {
              return false;
            }
          },
        }
      : undefined,
  };
};

export { makeClaudeAgent, PERMISSION_MODES };
