import { createInterface } from "node:readline";
import { type } from "arktype";
import { execa } from "execa";
import { isRecord, parseJson } from "../glv/parse.js";
import { reapDescendantsOnSettle } from "../glv/runner/reap.js";

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

/** provider id → models, for the configured providers only. */
type ProviderCatalog = ReadonlyMap<string, readonly CatalogModel[]>;

// One JSON-RPC reply over the ACP wire: id routes it to its pending
// request; result and error are mutually exclusive by convention but
// both optional here. Undeclared keys (jsonrpc) pass through untouched.
const AcpReply = type({
  "id?": "unknown",
  "result?": "unknown",
  "error?": { code: "number", message: "string" },
});
type AcpReply = typeof AcpReply.infer;

const INIT_TIMEOUT_MS = 10_000;
const LIST_TIMEOUT_MS = 15_000;
const LIVE_TIMEOUT_MS = 20_000;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const parseModels = (value: unknown): readonly CatalogModel[] => {
  if (!Array.isArray(value)) return [];
  const models: CatalogModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = asString(entry.id);
    if (id === undefined) continue;
    models.push({ id, label: asString(entry.name) ?? id });
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
  const send = (message: object): void => {
    proc.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const onLine = (line: string): void => {
    // A reply that misses the schema (like a non-JSON log line) is
    // dropped: the pending request resolves through its timeout instead.
    const parsed = parseJson(line, AcpReply);
    if (!parsed.ok) return;
    const reply = parsed.data;
    if (typeof reply.id !== "number") return;
    pending.get(reply.id)?.(reply);
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
  // Post-settle tree reap (#379): an agent that dies on its own would
  // leak its descendants into glv's process group — same rationale as
  // the runner's spawn.
  reapDescendantsOnSettle(proc);

  let nextId = 0;
  const request = (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<AcpReply> =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ error: { code: -32000, message: "timed out" } });
      }, timeoutMs);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });

  return {
    notify: (method: string): void => {
      send({ jsonrpc: "2.0", method });
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
 * Ask the agent binary for the models each of `providerIds` (the
 * providers configured in config.yaml) offers. Returns an empty map
 * whenever the agent can't or won't answer — old binaries, missing ACP
 * support, or a timeout must all degrade to config-only model choices.
 */
const fetchProviderCatalog = async (
  binary: string,
  providerIds: readonly string[],
): Promise<ProviderCatalog> => {
  const catalog = new Map<string, readonly CatalogModel[]>();
  if (providerIds.length === 0) return catalog;
  const acp = startAcp(binary);
  try {
    const init = await acp.request("initialize", INIT_PARAMS, INIT_TIMEOUT_MS);
    if (init.error !== undefined) return catalog;
    acp.notify("initialized");
    const list = await acp.request(PROVIDERS_LIST, {}, LIST_TIMEOUT_MS);
    const entries = isRecord(list.result) ? list.result.entries : undefined;
    if (list.error !== undefined || !Array.isArray(entries)) return catalog;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const providerId = asString(entry.providerId);
      if (providerId !== undefined && providerIds.includes(providerId))
        catalog.set(providerId, parseModels(entry.models));
    }
    // Entries with a catalogue record but no static models (ACP adapters
    // like claude-acp) know their models only at runtime: ask each one.
    // Sequential to bound the load; a failed query leaves the provider's
    // models empty without failing the others.
    for (const providerId of providerIds) {
      const staticModels = catalog.get(providerId);
      if (staticModels === undefined || staticModels.length > 0) continue;
      const live = await acp.request(
        SUPPORTED_MODELS,
        { providerId },
        LIVE_TIMEOUT_MS,
      );
      const models = isRecord(live.result) ? live.result.models : undefined;
      catalog.set(
        providerId,
        Array.isArray(models) ? parseLiveModels(models) : [],
      );
    }
    return catalog;
  } finally {
    acp.kill();
  }
};

export type { ProviderCatalog };
export { fetchProviderCatalog };
