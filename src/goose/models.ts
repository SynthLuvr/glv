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
// dir (<root>/config); otherwise the platform default — XDG on Unix
// (~/.config/goose), Known Folders on Windows (%APPDATA%\Block\goose\config).
const gooseConfigPath = (): string => {
  const root = process.env.GOOSE_PATH_ROOT;
  if (root !== undefined && isAbsolute(root))
    return join(root, "config", "config.yaml");
  if (platform() === "win32")
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "Block",
      "goose",
      "config",
      "config.yaml",
    );
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "goose",
    "config.yaml",
  );
};

type ProviderEntry = { enabled: boolean; model: string };

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asEntry = (value: unknown): ProviderEntry | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled !== false,
    model: asString(record.model).trim(),
  };
};

type GooseModelConfig = {
  /** providers map in config order, filtered to usable entries. */
  readonly providers: ReadonlyMap<string, ProviderEntry>;
  /** Resolved the way goose's get_active_provider/get_active_model do. */
  readonly active: ModelSelection | undefined;
};

// Read per call (not cached) so `goose configure` changes surface on the
// next New Session render without restarting the server. A missing or
// malformed file degrades to "no models" rather than failing the route —
// the form then simply hides the picker.
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

  const providers = new Map<string, ProviderEntry>();
  const rawProviders = record.providers;
  if (typeof rawProviders === "object" && rawProviders !== null)
    for (const [name, value] of Object.entries(rawProviders)) {
      const entry = asEntry(value);
      if (entry === undefined || entry.model === "" || !entry.enabled) continue;
      providers.set(name, entry);
    }

  const envProvider = process.env.GOOSE_PROVIDER?.trim();
  const envModel = process.env.GOOSE_MODEL?.trim();
  const configProvider = asString(record.active_provider).trim();
  const provider = envProvider || configProvider || undefined;
  const entry = provider === undefined ? undefined : providers.get(provider);
  const model = envModel || entry?.model || undefined;
  const active =
    provider !== undefined && model !== undefined
      ? { provider, model }
      : undefined;

  return { providers, active };
};

// Dropdown copy: provider and model, the same pair goose's own status line
// shows, so the option is unambiguous when two providers share a model id.
const choiceLabel = (provider: string, model: string): string =>
  `${provider} — ${model}`;

const makeGooseModelSource = (): ModelSource => {
  const choices = (): readonly ModelChoice[] => {
    const { providers, active } = readModelConfig();
    const names =
      active !== undefined && providers.has(active.provider)
        ? [
            active.provider,
            ...[...providers.keys()].filter((n) => n !== active.provider),
          ]
        : [...providers.keys()];
    return names.map((provider) => {
      const model = providers.get(provider)?.model ?? "";
      return { provider, model, label: choiceLabel(provider, model) };
    });
  };
  return {
    choices,
    defaultSelection: () => readModelConfig().active,
    resolve: (provider) => {
      const { providers } = readModelConfig();
      const entry = providers.get(provider);
      return entry === undefined ? undefined : { provider, model: entry.model };
    },
  };
};

export { makeGooseModelSource };
