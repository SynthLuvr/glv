import { readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import type {
  ModelChoice,
  ModelSelection,
  ModelSource,
} from "../glv/models.js";
import { isRecord } from "../glv/parse.js";
import { fetchProviderCatalog, type ProviderCatalog } from "./acp-catalog.js";

// Mirrors goose's config/paths.rs: GOOSE_PATH_ROOT redirects every goose
// dir (<root>/config); otherwise the platform default — ~/.config/goose on
// Unix, %APPDATA%\Block\goose\config on Windows. Like glv's own db-path.ts,
// the Unix branch resolves via HOME rather than ambient XDG_* vars: a stray
// XDG_CONFIG_HOME (CI runners set it) would point at a different profile
// than the HOME the tests fake.
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
  if (!isRecord(value) || value.enabled === false) return undefined;
  const model = asString(value.model).trim();
  return model === "" ? undefined : model;
};

type GooseModelConfig = {
  /** Usable providers in config order, provider name → configured model id. */
  readonly providers: ReadonlyMap<string, string>;
  /** Resolved the way goose's get_active_provider/get_active_model do. */
  readonly active: ModelSelection | undefined;
};

const NO_MODELS: GooseModelConfig = { providers: new Map(), active: undefined };

const readProviders = (
  record: Record<string, unknown>,
): ReadonlyMap<string, string> => {
  const providers = new Map<string, string>();
  const raw = record.providers;
  if (!isRecord(raw)) return providers;
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
  const model = process.env.GOOSE_MODEL?.trim() || providers.get(provider);
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
    return NO_MODELS;
  }
  if (!isRecord(doc)) return NO_MODELS;
  const providers = readProviders(doc);
  return { providers, active: resolveActive(doc, providers) };
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

// The dropdown offers provider/model pairs, so the submitted form value
// packs both as "provider:model" (split at the first colon: model ids may
// contain colons, provider ids never do).
const encodeChoiceValue = (provider: string, model: string): string =>
  `${provider}:${model}`;

const decodeChoiceValue = (value: string): ModelSelection | undefined => {
  const sep = value.indexOf(":");
  if (sep <= 0 || sep === value.length - 1) return undefined;
  return { provider: value.slice(0, sep), model: value.slice(sep + 1) };
};

const EMPTY_CATALOG: ProviderCatalog = new Map();
const CATALOG_TTL_MS = 60_000;
const CATALOG_RETRY_MS = 5_000;

const makeGooseModelSource = (binary: string): ModelSource => {
  // The catalogue is static for a given goose binary, so it is fetched at
  // most once per TTL and shared between concurrent renders. A failed or
  // empty fetch is retried sooner; the picker degrades to config-only
  // models meanwhile.
  let cache: { at: number; ttl: number; catalog: ProviderCatalog } | undefined;
  let inflight: Promise<ProviderCatalog> | undefined;

  const currentCatalog = (): Promise<ProviderCatalog> => {
    if (cache !== undefined && Date.now() - cache.at < cache.ttl)
      return Promise.resolve(cache.catalog);
    if (inflight === undefined) {
      inflight = (async () => {
        const ids = [...readModelConfig().providers.keys()];
        const fetched = await fetchProviderCatalog(binary, ids).catch(
          () => EMPTY_CATALOG,
        );
        cache = {
          at: Date.now(),
          ttl: fetched.size > 0 ? CATALOG_TTL_MS : CATALOG_RETRY_MS,
          catalog: fetched,
        };
        return fetched;
      })();
      void inflight.finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };

  const choices = async (): Promise<readonly ModelChoice[]> => {
    const { providers, active } = readModelConfig();
    const catalog = await currentCatalog();
    const out: ModelChoice[] = [];
    for (const provider of orderedProviderNames(providers, active)) {
      const configured = providers.get(provider) ?? "";
      const models = [...(catalog.get(provider) ?? [])];
      // The configured model is always offered, even when the catalogue is
      // unavailable or doesn't know it (e.g. a custom provider).
      if (!models.some((model) => model.id === configured))
        models.push({ id: configured, label: configured });
      for (const model of models)
        out.push({
          provider,
          label: model.label,
          value: encodeChoiceValue(provider, model.id),
        });
    }
    return out;
  };

  const resolve = (value: string): ModelSelection | undefined => {
    const selection = decodeChoiceValue(value);
    if (selection === undefined) return undefined;
    const configured = readModelConfig().providers.get(selection.provider);
    if (configured === undefined) return undefined;
    if (selection.model === configured) return selection;
    // Validate against whatever catalogue state is already cached — never
    // spawn for a submit. With nothing cached any model id is accepted;
    // goose itself rejects unknown models at run time.
    const known = cache?.catalog.get(selection.provider);
    if (known !== undefined && !known.some((m) => m.id === selection.model))
      return undefined;
    return selection;
  };

  return {
    choices,
    defaultSelection: () => readModelConfig().active,
    resolve,
  };
};

export { gooseConfigPath, makeGooseModelSource };
