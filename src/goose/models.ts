import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import type {
  ModelChoice,
  ModelSelection,
  ModelSource,
} from "../glv/models.js";

// Mirrors goose's config/paths.rs: GOOSE_PATH_ROOT redirects every goose
// dir (<root>/config); otherwise the platform default — ~/.config/goose on
// Unix, Known Folders on Windows (%APPDATA%\Block\goose\config). Like glv's
// own db-path.ts, the Unix branch resolves via HOME rather than ambient
// XDG_* vars: a stray XDG_CONFIG_HOME (CI runners set it) would point at a
// different profile than the HOME the tests fake.
const gooseConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const root = env.GOOSE_PATH_ROOT;
  if (root !== undefined && isAbsolute(root))
    return join(root, "config", "config.yaml");
  if (platform() === "win32")
    return join(
      env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Block",
      "goose",
      "config",
      "config.yaml",
    );
  return join(env.HOME ?? homedir(), ".config", "goose", "config.yaml");
};

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

// A provider entry feeds the picker only when it is enabled and names a
// model.
const usableModel = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.enabled === false) return undefined;
  const model = asString(record.model).trim();
  return model === "" ? undefined : model;
};

type GooseModelConfig = {
  /** Usable providers in config order, provider name → model id. */
  readonly providers: ReadonlyMap<string, string>;
  /** Resolved the way goose's get_active_provider/get_active_model do. */
  readonly active: ModelSelection | undefined;
};

const readProviders = (
  record: Record<string, unknown>,
): ReadonlyMap<string, string> => {
  const providers = new Map<string, string>();
  const raw = record.providers;
  if (typeof raw !== "object" || raw === null) return providers;
  for (const [name, value] of Object.entries(raw)) {
    const model = usableModel(value);
    if (model !== undefined) providers.set(name, model);
  }
  return providers;
};

// GOOSE_PROVIDER/GOOSE_MODEL override active_provider, like goose itself.
const resolveActive = (
  record: Record<string, unknown>,
  providers: ReadonlyMap<string, string>,
): ModelSelection | undefined => {
  const provider =
    process.env.GOOSE_PROVIDER?.trim() ||
    asString(record.active_provider).trim() ||
    undefined;
  if (provider === undefined) return undefined;
  const model =
    process.env.GOOSE_MODEL?.trim() || providers.get(provider) || undefined;
  return model === undefined ? undefined : { provider, model };
};

// Read per call so `goose configure` edits surface on the next New Session
// render without a restart. A missing or malformed file degrades to "no
// models", which hides the picker rather than failing the route.
const readModelConfig = (): GooseModelConfig => {
  let doc: unknown;
  try {
    doc = parse(readFileSync(gooseConfigPath(), "utf8"));
  } catch {
    return { providers: new Map(), active: undefined };
  }
  if (typeof doc !== "object" || doc === null)
    return { providers: new Map(), active: undefined };
  const record = doc as Record<string, unknown>;
  const providers = readProviders(record);
  return { providers, active: resolveActive(record, providers) };
};

// The active provider leads the list so goose's own default is easy to find.
const orderedProviderNames = (
  providers: ReadonlyMap<string, string>,
  active: ModelSelection | undefined,
): readonly string[] => {
  const names = [...providers.keys()];
  if (active === undefined || !providers.has(active.provider)) return names;
  return [active.provider, ...names.filter((name) => name !== active.provider)];
};

const makeGooseModelSource = (): ModelSource => {
  const choices = (): readonly ModelChoice[] => {
    const { providers, active } = readModelConfig();
    return orderedProviderNames(providers, active).map((provider) => ({
      provider,
      label: `${provider} — ${providers.get(provider)}`,
    }));
  };
  return {
    choices,
    defaultSelection: () => readModelConfig().active,
    resolve: (provider) => {
      const model = readModelConfig().providers.get(provider);
      return model === undefined ? undefined : { provider, model };
    },
  };
};

export { gooseConfigPath, makeGooseModelSource };
