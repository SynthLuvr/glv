# ADR 0002: Swap goose for claude Code as the session engine

- Status: Accepted
- Date: 2026-08-14
- Deciders: glv maintainers

## Context

glv launched as a viewer + launcher for the goose CLI: it read goose’s
SQLite `sessions.db` read-only, spawned `goose run` for new sessions,
and discovered each new session by polling the database for a fresh row
in the working directory. The engine is being replaced by claude Code
(Claude Code ≥ 2.x). Every touchpoint — storage, session identity,
guardrail injection, permissions, CLI surface — needed a decision, and
each non-obvious one was verified empirically against claude 2.1.232
rather than assumed from docs.

## Decision

Drive claude, and adopt the following positions.

**Storage.** Read claude’s own append-only JSONL transcripts under
`~/.claude/projects` (`CLAUDE_CONFIG_DIR` honoured, `--projects-dir`
override). Rename/archive metadata lives in a glv-owned SQLite sidecar
(`meta.db`) — the viewer never writes a byte of claude’s files, so
browsing stays safe while sessions run. Working directories come from
the `cwd` field on transcript lines; when a foreign file carries none,
“” is reported instead of decoding the dashed directory name, because a
wrong path is worse than none.

**Session identity.** glv generates the session UUID and passes it via
`--session-id` (verified: claude honours it and names the transcript
`<uuid>.jsonl` accordingly). This deletes the goose-era temp-key →
poll-directory → rekey dance and its misattribution failure mode — a
transcript started from a terminal in the same directory during the
discovery window could previously be claimed by the wrong run. The
remaining confirmation step (waiting for the pre-assigned file to
appear, bounded by `pollTimeoutMs`) can only ever match one exact file.

**Guardrails.** `--append-system-prompt` is passed on every invocation,
including `--resume` runs. Verified empirically: a persona injected on
the first prompt is absent from a resumed turn without the flag (“6”
instead of “BANANA”) and restored with it — identical semantics to
goose’s `--system`. `--append-system-prompt` (not `--system-prompt`)
because the replace variant strips claude’s built-in tool instructions.

**Permissions.** glv runs claude headless (`--print`), where permission
prompts cannot be shown and approval-needing tool calls are simply
denied. Verified: with the stock mode a headless file-write is declined,
which would make glv-launched sessions read-only agents. glv therefore
defaults to `--permission-mode acceptEdits` and exposes `manual`,
`auto`, `dontAsk`, and `bypassPermissions` via serve configuration
(`plan` is excluded — in print mode it returns a plan instead of
acting). Security note: `bypassPermissions` hands the agent full agency
inside arbitrary user-chosen working directories behind a single
passkey; treat it as equivalent to distributing shell access.

**Tokens.** The sidebar shows the last per-turn usage snapshot (input +
cache + output of the most recent turn) — claude reports usage per turn,
so a cumulative total would double-count input tokens. This is a
context-size figure, not goose’s cumulative total; the chip’s meaning
changed with the engine.

**Windows.** The project-directory name encoding (separators, dots,
underscores → dashes) was probed on Linux only. The colon rule for drive
letters is added by analogy but unverified on a Windows host. Exposure
is minimal — after the `--session-id` change the encoding only affects
directory-scoped lookups (`sessionIdsInDir`); working directories are
never decoded from directory names.

**CLI surface.** `--db`/`GOOSE_SESSIONS_DB`, `--goose-binary`,
`glv logs`, and `sessions --type` are removed — claude has no equivalent
hidden-session store or session-type split.

## Consequences

- The store is a pure reader over claude’s files plus one small sidecar
  DB; no engine-owned database is written, so upgrades of claude cannot
  desync viewer state.
- Transcript parsing is guarded (sidechain filtering, malformed-line
  skipping, permissive item shapes) and cached by (mtime, size) so the
  polling sidebar stays cheap on large stores.
- Anyone relying on the removed flags/commands must migrate; the
  permission-mode default means glv-launched agents can edit files out
  of the box but still respect the user’s claude allowlists for
  everything else.
