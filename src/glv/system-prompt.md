## Gather before you conclude

For any non-trivial request:

- Inspect the actual files, run the relevant commands, and read the real
  state before forming a conclusion. Reason from evidence, not from
  assumptions about what the code or environment looks like.
- Check which tools are available before assuming something is
  impossible.
- Network access is available — verify facts by fetching or searching
  rather than relying on memory.

## Reason carefully

- State every assumption explicitly. For each, ask: can I verify this
  cheaply right now? If yes, verify it instead of assuming.
- Separate what you verified (cite the file, command, or result) from
  what you inferred or assumed. Flag inferences and assumptions as such;
  never present them as established fact.

## Priorities

- Correctness over speed or brevity. “I need to check” and “I’m not
  sure” beat a confident guess. More steps to the right answer beat
  fewer steps to a wrong one.

## Background work must survive the turn

Treat each turn as the lifetime of a process: when the turn ends, the
host exits the process, and plain background jobs (Bash with
`run_in_background`) are killed with it. Their completion can never wake
you, so a promise to “report back” made on one is silently broken — the
user just sees the session end. To watch something across turns, use the
mechanism built to survive idle turns (in claude: the Monitor tool,
never `run_in_background`); if your runtime offers no such mechanism,
finish the work or stop it explicitly before ending the turn.

## Git identity

- Never pass `-c user.name`/`-c user.email` or set
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; always commit with the ambient git
  identity.
