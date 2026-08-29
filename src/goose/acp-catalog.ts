import { createInterface } from "node:readline";
import { execa } from "execa";

// goose exposes its provider/model catalogue over ACP (the same protocol
// `goose acp` serves to editors) as unstable extensions:
//   _goose/unstable/providers/list
//     → every known provider incl. its static model list
//   _goose/unstable/providers/supported-models/list
//     → the models a provider reports at runtime, used for entries whose
//       static list is empty (ACP-style providers like claude-acp delegate
//       to the wrapped agent, which knows its own models)
// Both are goose-specific and unstable: every failure path here must
// degrade (the caller falls back to config.yaml), never throw.

/** One model a provider offers, as the picker needs it. */
type CatalogModel = {
  readonly id: string;
  readonly label: string;
};

/** A catalogue provider: display name plus the models it offers. */
type CatalogProvider = {
  readonly name: string | undefined;
  readonly models: readonly CatalogModel[];
};

/** provider id → catalogue entry, for the configured providers only. */
type ProviderCatalog = ReadonlyMap<string, CatalogProvider>;

type AcpReply = {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
};

const INIT_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 20_000;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const parseModels = (value: unknown): readonly CatalogModel[] => {
  if (!Array.isArray(value)) return [];
  const models: CatalogModel[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const id = asString(record.id);
    if (id === undefined) continue;
    models.push({ id, label: asString(record.name) ?? id });
  }
  return models;
};

const parseLiveModels = (value: unknown): readonly CatalogModel[] =>
  Array.isArray(value)
    ? value.flatMap((model) => {
        const id = asString(model);
        return id === undefined ? [] : [{ id, label: id }];
      })
    : [];

// One newline-delimited JSON-RPC conversation with `<binary> acp`.
// Requests get an id, a timeout, and exactly one resolved reply;
// non-JSON stdout lines are ignored (agents may log there), and a dead
// process fails every pending request instead of hanging the caller.
const startAcp = (binary: string) => {
  const proc = execa(binary, ["acp"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    reject: false,
    // A live-models query may spawn the provider's own adapter; take the
    // whole tree down when the conversation ends.
    killDescendants: true,
  });
  const pending = new Map<number, (reply: AcpReply) => void>();
  const onLine = (line: string): void => {
    let msg: { id?: unknown };
    try {
      msg = JSON.parse(line) as { id?: unknown };
    } catch {
      return;
    }
    if (typeof msg.id === "number") pending.get(msg.id)?.(msg as AcpReply);
  };
  if (proc.stdout !== undefined)
    createInterface({ input: proc.stdout }).on("line", onLine);
  const failAll = (): void => {
    for (const resolve of pending.values())
      resolve({ error: { code: -32000, message: "agent exited" } });
    pending.clear();
  };
  // Resolves once the process is gone for any reason (spawn failure,
  // crash, our kill): nothing may hang waiting on a dead agent.
  void proc.then(failAll, failAll);

  const request = (
    id: number,
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<AcpReply> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { code: -32000, message: "timed out" } });
      }, timeoutMs);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      proc.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });

  return {
    notify: (method: string): void => {
      proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    request,
    kill: (): void => {
      proc.kill();
    },
  };
};

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
};

const PROVIDERS_LIST = "_goose/unstable/providers/list";
const SUPPORTED_MODELS = "_goose/unstable/providers/supported-models/list";

/**
 * Ask the agent binary for the catalogue entries of `providerIds` (the
 * providers configured in config.yaml). Returns an empty map whenever the
 * agent can't or won't answer — old binaries, missing ACP support, or a
 * timeout must all degrade to config-only model choices.
 */
const fetchProviderCatalog = async (
  binary: string,
  providerIds: readonly string[],
): Promise<ProviderCatalog> => {
  const catalog = new Map<string, CatalogProvider>();
  if (providerIds.length === 0) return catalog;
  const acp = startAcp(binary);
  try {
    const init = await acp.request(
      1,
      "initialize",
      INIT_PARAMS,
      INIT_TIMEOUT_MS,
    );
    if (init.error !== undefined) return catalog;
    acp.notify("initialized");
    const list = await acp.request(2, PROVIDERS_LIST, {}, LIST_TIMEOUT_MS);
    const entries = asRecord(list.result)?.entries;
    if (list.error !== undefined || !Array.isArray(entries)) return catalog;
    for (const entry of entries) {
      const record = asRecord(entry);
      if (record === undefined) continue;
      const providerId = asString(record.providerId);
      if (providerId === undefined) continue;
      catalog.set(providerId, {
        name: asString(record.providerName),
        models: parseModels(record.models),
      });
    }
    // Entries with a catalogue record but no static models (ACP adapters
    // like claude-acp) know their models only at runtime: ask each one.
    // Sequential to bound the load; a failed query leaves the provider's
    // models empty without failing the others.
    let nextId = 3;
    for (const providerId of providerIds) {
      const entry = catalog.get(providerId);
      if (entry === undefined || entry.models.length > 0) continue;
      const live = await acp.request(
        nextId,
        SUPPORTED_MODELS,
        { providerId },
        LIVE_TIMEOUT_MS,
      );
      nextId += 1;
      const models = asRecord(live.result)?.models;
      catalog.set(providerId, {
        name: entry.name,
        models: Array.isArray(models) ? parseLiveModels(models) : [],
      });
    }
    return catalog;
  } finally {
    acp.kill();
  }
};

export type { ProviderCatalog };
export { fetchProviderCatalog };
