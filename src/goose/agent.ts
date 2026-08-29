import type { ModelSelection } from "../glv/models.js";
import type { AgentInvocation } from "../glv/runner/types.js";
import { DEFAULT_SYSTEM_PROMPT } from "../glv/system.js";
import { gooseProfile } from "./profile.js";

// goose reads instructions from stdin via `-i -` (the `-` is the stdin
// marker), never as a `-t` argument — this sidesteps the OS argument-length
// limit and all shell-quoting concerns, and works for arbitrarily long
// prompts.
const STREAM_FLAGS = ["--output-format", "stream-json", "-i", "-"];

// DESIGN DECISION: --system MUST be passed on every invocation, including
// resume (`-r`) sessions — not just the first prompt of a new session.
//
// goose does NOT persist the --system flag across resume sessions. It is a
// per-invocation runtime injection: goose applies it fresh on each `goose run`
// but never writes it into the stored conversation history. This was verified
// empirically against goose 1.45.0:
//
//   1. New session + --system "pirate persona" → response in pirate-speak ✓
//   2. Resume WITHOUT --system                → normal English, persona lost ✗
//   3. Resume WITH --system                   → pirate persona restored ✓
//
// The system-prompt text was also confirmed absent from the persisted session
// database — only user/assistant/tool messages are stored, not the --system
// value. Removing --system from resume would silently strip the guardrails
// from every follow-up, reverting the model to stock goose behaviour.
//
// The token cost is negligible: ~240 tokens (156 words) vs. the 10K–100K+
// tokens of a typical resumed conversation — well under 1% overhead.
//
// The only alternative that would avoid per-invocation passing is setting the
// prompt at the goose config level (~/.config/goose/config.yaml), but that
// affects ALL goose usage system-wide, not just GLV-managed sessions.
const SYSTEM_FLAGS = ["--system", DEFAULT_SYSTEM_PROMPT];

// A model picked on the New Session form is a start-time decision: both
// flags go together because a model id only means something to its provider.
// No selection (the "goose default" option) passes no flags, so goose's own
// env/config precedence stays in charge. Resumes never pass them — the
// session keeps the model it started with.
const modelFlags = (model: ModelSelection | undefined): string[] =>
  model === undefined
    ? []
    : ["--provider", model.provider, "--model", model.model];

// goose discovers its own session id by writing to its database, so the
// runner's handle key is never forwarded to the binary: new sessions start
// without one and the launch strategy discovers the real id afterwards.
const makeGooseAgent = (binary: string): AgentInvocation => ({
  name: gooseProfile.agentName,
  binary,
  newSession: (_prompt, _key, model) => [
    "run",
    ...SYSTEM_FLAGS,
    ...modelFlags(model),
    ...STREAM_FLAGS,
  ],
  resume: (key) => [
    "run",
    "-r",
    ...SYSTEM_FLAGS,
    "--session-id",
    key,
    ...STREAM_FLAGS,
  ],
  env: () => ({}),
});

export { makeGooseAgent };
