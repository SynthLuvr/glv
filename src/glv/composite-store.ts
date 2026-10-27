import { namespacedId, splitNamespacedId } from "./agents.js";
import type { SessionFilter, SessionRow, SessionStore } from "./sessions.js";

// One agent's store under the composite: the agent id that prefixes its
// sessions, and the flavor store speaking its native ids.
type CompositeStoreEntry = {
  readonly agent: string;
  readonly store: SessionStore;
};

// Rows cross the boundary with their ids prefixed (and the agent
// stamped), so every consumer (URLs, SSE payloads, group members,
// upload tags, chips) sees one id space.
const prefixedRow = (agent: string, row: SessionRow): SessionRow => ({
  ...row,
  id: namespacedId(agent, row.id),
  agent,
});

// The SessionStore over several agents' stores: listing merges every
// child (newest-first by updated_at, capped at the filter limit) and
// mutations dispatch each id to the child its prefix names. Ids are
// prefixed on the way out and stripped on the way in; everything above
// this layer only ever sees namespaced ids. A raw or unknown-agent id
// routes nowhere — every composite consumer spells prefixed ids.
const createCompositeSessionStore = (
  entries: readonly CompositeStoreEntry[],
): SessionStore => {
  const route = (
    id: string,
  ):
    | { readonly entry: CompositeStoreEntry; readonly nativeId: string }
    | undefined => {
    const split = splitNamespacedId(id);
    if (split === undefined) return undefined;
    const entry = entries.find((candidate) => candidate.agent === split.agent);
    return entry === undefined ? undefined : { entry, nativeId: split.id };
  };

  // Groups ids by their agent prefix; ids that route nowhere are
  // dropped from every mutation.
  const byAgent = (
    ids: readonly string[],
  ): Map<CompositeStoreEntry, string[]> => {
    const groups = new Map<CompositeStoreEntry, string[]>();
    for (const id of ids) {
      const target = route(id);
      if (target === undefined) continue;
      const bucket = groups.get(target.entry);
      if (bucket === undefined) groups.set(target.entry, [target.nativeId]);
      else bucket.push(target.nativeId);
    }
    return groups;
  };

  // Both children list newest-first; a stable two-way merge preserves
  // that order across agents without a full re-sort. Ties (identical
  // updated_at) keep the entry order the caller gave.
  const mergeNewestFirst = (
    lists: readonly SessionRow[][],
    limit: number,
  ): SessionRow[] => {
    const merged: SessionRow[] = [];
    const cursors = lists.map(() => 0);
    while (merged.length < limit) {
      let bestList = -1;
      for (let i = 0; i < lists.length; i++) {
        if (cursors[i] >= lists[i].length) continue;
        if (bestList === -1) bestList = i;
        else {
          const a = lists[bestList][cursors[bestList]];
          const b = lists[i][cursors[i]];
          if (b.updated_at > a.updated_at) bestList = i;
        }
      }
      if (bestList === -1) break;
      merged.push(lists[bestList][cursors[bestList]]);
      cursors[bestList]++;
    }
    return merged;
  };

  // The filter as one child sees it: the composite's id restriction
  // carries namespaced ids, so each child receives exactly its own
  // members with the prefix stripped.
  const childFilterFor = (
    entry: CompositeStoreEntry,
    filter: SessionFilter,
  ): SessionFilter => {
    if (filter.ids === undefined) return filter;
    const native = new Set<string>();
    for (const id of filter.ids) {
      const split = splitNamespacedId(id);
      if (split !== undefined && split.agent === entry.agent)
        native.add(split.id);
    }
    return { ...filter, ids: native };
  };

  return {
    listSessions: (filter) => {
      // Offset applies to the merged (globally newest-first) order, not
      // to each child's own list — skipping per child would drop rows
      // that belong in the window. Children therefore return enough rows
      // to cover offset + limit (offset disabled inside the child
      // filter), and the composite drops the first `offset` after the
      // merge.
      const offset = filter.offset ?? 0;
      const childFilter =
        offset === 0
          ? filter
          : { ...filter, offset: 0, limit: filter.limit + offset };
      // The agent restriction (#344) routes the listing to the one child
      // it names — filtering after the merge would page wrong, the other
      // agents' rows eating the window. An unknown agent routes nowhere
      // and lists nothing.
      const targets =
        filter.agent === undefined
          ? entries
          : entries.filter((entry) => entry.agent === filter.agent);
      return mergeNewestFirst(
        targets.map((entry) =>
          entry.store
            .listSessions(childFilterFor(entry, childFilter))
            .map((row) => prefixedRow(entry.agent, row)),
        ),
        childFilter.limit,
      ).slice(offset);
    },

    getSession: (id) => {
      const target = route(id);
      if (target === undefined) return undefined;
      const row = target.entry.store.getSession(target.nativeId);
      return row === undefined
        ? undefined
        : prefixedRow(target.entry.agent, row);
    },

    listMessages: (id) => {
      const target = route(id);
      return target === undefined
        ? []
        : target.entry.store.listMessages(target.nativeId);
    },

    countMessages: (id) => {
      const target = route(id);
      return target === undefined
        ? 0
        : target.entry.store.countMessages(target.nativeId);
    },

    archiveSessions: (ids) => {
      for (const [entry, native] of byAgent(ids))
        entry.store.archiveSessions(native);
    },

    renameSession: (id, rawName) => {
      const target = route(id);
      if (target !== undefined)
        target.entry.store.renameSession(target.nativeId, rawName);
    },

    deleteSessions: (ids) => {
      for (const [entry, native] of byAgent(ids))
        entry.store.deleteSessions(native);
    },

    forkSession: (id, cutoff) => {
      const target = route(id);
      if (target === undefined)
        return { ok: false, status: 404, error: `No session ${id}.` };
      const result = target.entry.store.forkSession(target.nativeId, cutoff);
      return result.ok
        ? { ok: true, row: prefixedRow(target.entry.agent, result.row) }
        : result;
    },

    firstPromptSessionName: (ids) => {
      for (const [entry, native] of byAgent(ids)) {
        const name = entry.store.firstPromptSessionName(native);
        if (name !== undefined) return name;
      }
      return undefined;
    },

    prCandidateIds: (ids) => {
      const result = new Set<string>();
      for (const [entry, native] of byAgent(ids))
        for (const id of entry.store.prCandidateIds(native))
          result.add(namespacedId(entry.agent, id));

      return result;
    },
  };
};

export type { CompositeStoreEntry };
export { createCompositeSessionStore };
