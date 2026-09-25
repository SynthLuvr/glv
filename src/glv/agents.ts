const SEPARATOR = ":";

// Namespaced session ids: the composite boundary prefixes every id that
// crosses it with its agent ("goose:<id>", "claude:<id>"). Per-flavor
// stores keep their native ids; only the composite spells the prefix.
// Agent ids are lowercase-led slugs and both agents mint uuid-shaped
// session ids (no colon), so a prefixed id always splits unambiguously
// at the first colon.
const AGENT_ID_RE = /^[a-z][a-z0-9_-]*$/;

const isAgentId = (agent: string): boolean => AGENT_ID_RE.test(agent);

const namespacedId = (agent: string, id: string): string =>
  `${agent}${SEPARATOR}${id}`;

// Undefined for anything that does not carry a recognizable prefix — a
// raw id, an unknown agent, or a malformed pair.
const splitNamespacedId = (
  id: string,
): { readonly agent: string; readonly id: string } | undefined => {
  const sep = id.indexOf(SEPARATOR);
  if (sep <= 0 || sep === id.length - 1) return undefined;
  const agent = id.slice(0, sep);
  return isAgentId(agent) ? { agent, id: id.slice(sep + 1) } : undefined;
};

const agentOfId = (id: string): string | undefined =>
  splitNamespacedId(id)?.agent;

// A namespaced id carries a colon, which is legal in an id attribute but
// not in a querySelector — and htmx oob swaps target elements by
// `#<id>`. Native ids are uuids, so the swap is injective in practice.
const domIdOf = (id: string): string => id.replaceAll(SEPARATOR, "_");

export { agentOfId, domIdOf, isAgentId, namespacedId, splitNamespacedId };
