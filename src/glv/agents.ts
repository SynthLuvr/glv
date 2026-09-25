const SEPARATOR = ":";

// Namespaced session ids: the composite boundary prefixes every id that
// crosses it with its agent ("goose:<id>", "claude:<id>"). Per-flavor
// stores keep their native ids; only the composite spells the prefix.
// Agent ids are lowercase-led slugs and both agents mint uuid-shaped
// session ids (no colon), so a prefixed id always splits unambiguously
// at the first colon.
const AGENT_ID_RE = /^[a-z][a-z0-9_-]*$/;

// True when `agent` is a well-formed agent id ("goose", "claude").
const isAgentId = (agent: string): boolean => AGENT_ID_RE.test(agent);

// The composite boundary's spelling of a flavor-native session id.
const namespacedId = (agent: string, id: string): string =>
  `${agent}${SEPARATOR}${id}`;

// Splits a namespaced id into its agent and native id parts. Undefined
// for anything that does not carry a recognizable prefix — a raw id, an
// unknown agent, or a malformed pair.
const splitNamespacedId = (
  id: string,
): { readonly agent: string; readonly id: string } | undefined => {
  const sep = id.indexOf(SEPARATOR);
  if (sep <= 0 || sep === id.length - 1) return undefined;
  const agent = id.slice(0, sep);
  return isAgentId(agent) ? { agent, id: id.slice(sep + 1) } : undefined;
};

// A session id's agent prefix, when it has one.
const agentOfId = (id: string): string | undefined =>
  splitNamespacedId(id)?.agent;

export { agentOfId, isAgentId, namespacedId, splitNamespacedId };
