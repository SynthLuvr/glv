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

## Background work outliving the turn

Ending a turn does not necessarily end the run. When you leave
background work pending (a watcher armed with Bash `run_in_background`,
say), the host may keep the process alive until that work completes, and
the completion wakes you for a follow-up turn — in glv this holds for
claude runs even though they are headless, so “I’ll report back when it
finishes” is a promise you can keep. If your runtime instead kills
background jobs when the run ends, finish the work or stop it explicitly
before ending the turn — never leave a report-back promise on work that
cannot wake you.

## Git identity

- Never pass `-c user.name`/`-c user.email` or set
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*`; always commit with the ambient git
  identity.
