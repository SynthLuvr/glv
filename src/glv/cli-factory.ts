import { Command } from "commander";
import * as cli from "./cli-shared.js";
import { runList } from "./commands/list.js";
import type { SessionFilter, SessionStore } from "./sessions.js";

// Options shared by every list-style command the factory registers.
type ListOpts = {
  limit: string;
  all?: boolean;
  type?: string;
};

// What a flavor registers with the shared program factory: the global
// flags it adds, how a read-only store is opened for list/view, and the
// serve command it wires. The factory owns everything structural (the
// sessions/view commands, the shared serve flags) so a flavor CLI
// differs from its peer only in its adapters.
type FlavorProgramSpec = {
  readonly programName: string;
  readonly description: string;
  /** Registers the flavor's global options on the program. */
  readonly globalOptions: (program: Command) => void;
  /**
   * Opens the flavor's store read-only for the list/view commands and
   * closes it after `fn` returns.
   */
  readonly useStore: (fn: (sessions: SessionStore) => void) => void;
  /** Extra options on the `sessions` command (goose's --type). */
  readonly sessionsOptions?: (cmd: Command) => Command;
  /** Maps the parsed `sessions` options to a listing filter. */
  readonly sessionsFilter: (opts: ListOpts) => SessionFilter;
  /** The flavor's `sessions` command description. */
  readonly sessionsDescription: string;
  /**
   * Registers extra list-style commands built from the same store (goose's
   * `logs`): name, description, flavor options, and the fixed filter the
   * command lists.
   */
  readonly fixedListCommands?: readonly {
    readonly name: string;
    readonly description: string;
    readonly options?: (cmd: Command) => Command;
    readonly filter: SessionFilter;
  }[];
  /** The flavor's serve command, options included. */
  readonly serve: {
    readonly description: string;
    readonly options: (cmd: Command) => Command;
    readonly action: (opts: Record<string, unknown>) => void;
  };
};

// Builds one flavor's whole commander program: the flavor's global
// options, the shared `sessions`/`view` commands, any extra list
// commands, and serve. Both legacy CLIs are thin configs over this
// factory, and the merged `glv` CLI reuses the same pieces.
const createFlavorProgram = (spec: FlavorProgramSpec): Command => {
  const program = new Command();
  program.name(spec.programName).description(spec.description);
  spec.globalOptions(program);

  const sessionsBase = program
    .command("sessions")
    .description(spec.sessionsDescription);
  const sessionsCmd = spec.sessionsOptions?.(sessionsBase) ?? sessionsBase;
  sessionsCmd
    .option("--all", "include archived sessions")
    .option(
      "-n, --limit <number>",
      "number of rows to list",
      cli.parsePositiveInt,
      20,
    )
    .action((opts: ListOpts) =>
      spec.useStore((sessions) => runList(sessions, spec.sessionsFilter(opts))),
    );

  cli.registerViewCommand(program, (sessionId) =>
    spec.useStore((sessions) => cli.runView(sessions, sessionId)),
  );

  for (const extra of spec.fixedListCommands ?? []) {
    const base = program.command(extra.name).description(extra.description);
    const cmd = extra.options?.(base) ?? base;
    cmd
      .option(
        "-n, --limit <number>",
        "number of rows to list",
        cli.parsePositiveInt,
        20,
      )
      .action((opts: ListOpts) =>
        spec.useStore((sessions) =>
          runList(sessions, { ...extra.filter, limit: Number(opts.limit) }),
        ),
      );
  }

  const serveBase = program
    .command("serve")
    .description(spec.serve.description);
  const serveCmd = spec.serve
    .options(serveBase)
    .option("-p, --port <number>", "port to listen on", "3000")
    .option(
      "-c, --max-concurrent <number>",
      "max concurrent agent runs",
      cli.parsePositiveInt,
      6,
    );
  cli.addServeTailOptions(serveCmd);
  serveCmd.action(spec.serve.action);

  return program;
};

export { createFlavorProgram };
