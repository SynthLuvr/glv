import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// The recipe is the single source of truth for the agent, extensions, and
// standing instructions GLV applies to every NEW goose session. It lives in
// the repo (recognized by the real goose binary via `--render-recipe`) and is
// translated here into `goose run` flags that are compatible with `-i -`
// (stdin prompts). `--recipe` itself cannot be used: it is mutually exclusive
// with `-i`/`-t`, and headless `goose run` requires the prompt through one of
// those, so the recipe's configuration must be expressed as CLI flags instead.
const RECIPE_PATH = fileURLToPath(
  new URL("../recipes/glv-default.yaml", import.meta.url),
);

type RecipeExtension = {
  type: string;
  name: string;
  cmd?: string;
  args?: string[];
  envs?: Record<string, string>;
  bundled?: boolean;
};

type Recipe = {
  instructions?: string;
  system?: string;
  agent?: { provider?: string; model?: string };
  extensions?: RecipeExtension[];
};

// POSIX shell-quote: wraps values that contain shell-significant characters in
// single quotes so goose's `--with-extension` parser (which is shell-words
// based) reconstructs them as a single argv element. Embedded single quotes
// are escaped with the '\'' idiom. Verified against the real goose binary with
// `bash -c '<script with spaces and $(expansions)>'`.
const shellQuote = (value: string): string => {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
};

// Renders one stdio extension as a single `--with-extension` argument:
//   ENV=val ... <cmd> <quoted-args...>
// The envs prefix matches goose's documented "--with-extension" format.
const renderStdioExtension = (ext: RecipeExtension): string => {
  const parts: string[] = [];
  if (ext.envs !== undefined)
    for (const [key, val] of Object.entries(ext.envs))
      parts.push(`${key}=${shellQuote(val)}`);
  if (ext.cmd === undefined)
    throw new Error(`stdio extension "${ext.name}" has no cmd`);
  parts.push(ext.cmd);
  for (const arg of ext.args ?? []) parts.push(shellQuote(arg));
  return parts.join(" ");
};

// Platform/builtin extensions that ship with goose are added via
// `--with-builtin` (comma-separated names); confirmed the real binary accepts
// every name in this recipe in a single flag.
const isBundledBuiltin = (ext: RecipeExtension): boolean =>
  ext.bundled === true && (ext.type === "platform" || ext.type === "builtin");

const translateRecipe = (recipe: Recipe): string[] => {
  const flags: string[] = ["--no-profile"];

  if (recipe.agent?.provider !== undefined)
    flags.push("--provider", recipe.agent.provider);
  if (recipe.agent?.model !== undefined)
    flags.push("--model", recipe.agent.model);

  // Both `system` and `instructions` are standing directives in a profile
  // context (the user's typed prompt is the per-run task via stdin), so they
  // are folded into a single `--system` preamble.
  const preamble = [recipe.system ?? "", recipe.instructions ?? ""]
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .join("\n\n");
  if (preamble !== "") flags.push("--system", preamble);

  const builtins: string[] = [];
  for (const ext of recipe.extensions ?? [])
    if (ext.type === "stdio") {
      flags.push("--with-extension", renderStdioExtension(ext));
    } else if (isBundledBuiltin(ext)) {
      builtins.push(ext.name);
    }

  if (builtins.length > 0) flags.push("--with-builtin", builtins.join(","));

  return flags;
};

const loadRecipe = (): Recipe => {
  const raw = parse(readFileSync(RECIPE_PATH, "utf-8")) as unknown;
  if (raw === null || typeof raw !== "object")
    throw new Error(`recipe at ${RECIPE_PATH} is not a YAML object`);
  return raw as Recipe;
};

// Computed once at module load: the bundled recipe is a committed asset, so a
// parse failure here is a programming bug to surface immediately.
const RECIPE_FLAGS = translateRecipe(loadRecipe());

export { RECIPE_FLAGS, RECIPE_PATH, translateRecipe };
