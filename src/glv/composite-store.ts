import { namespacedId, splitNamespacedId } from "./agents.js";
import type { SessionRow, SessionStore } from "./sessions.js";

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
// this layer only ever sees namespaced ids.
const createCompositeSessionStore = (
  entries: readonly CompositeStoreEntry[],
): SessionStore => {
  const childOf = (agent: string): CompositeStoreEntry | undefined =>
    entries.find((entry) => entry.agent === agent);

  // Groups ids by their agent prefix; a raw id (no prefix) matches
  // nothing — every composite consumer spells prefixed ids.
  const byAgent = (
    ids: readonly string[],
  ): Map<CompositeStoreEntry, string[]> => {
    const groups = new Map<CompositeStoreEntry, string[]>();
    for (const id of ids) {
      const split = splitNamespacedId(id);
      const entry = split === undefined ? undefined : childOf(split.agent);
      if (entry === undefined || split === undefined) continue;
      const bucket = groups.get(entry);
      if (bucket === undefined) groups.set(entry, [split.id]);
      else bucket.push(split.id);
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

  return {
    listSessions: (filter) =>
      mergeNewestFirst(
        entries.map((entry) =>
          entry.store
            .listSessions(filter)
            .map((row) => prefixedRow(entry.agent, row)),
        ),
        filter.limit,
      ),

    getSession: (id) => {
      const split = splitNamespacedId(id);
      const entry = split === undefined ? undefined : childOf(split.agent);
      if (entry === undefined || split === undefined) return undefined;
      const row = entry.store.getSession(split.id);
      return row === undefined ? undefined : prefixedRow(entry.agent, row);
    },

    listMessages: (id) => {
      const split = splitNamespacedId(id);
      const entry = split === undefined ? undefined : childOf(split.agent);
      if (entry === undefined || split === undefined) return [];
      return entry.store.listMessages(split.id);
    },

    archiveSessions: (ids) => {
      for (const [entry, native] of byAgent(ids))
        entry.store.archiveSessions(native);
    },

    renameSession: (id, rawName) => {
      const split = splitNamespacedId(id);
      const entry = split === undefined ? undefined : childOf(split.agent);
      if (entry !== undefined && split !== undefined)
        entry.store.renameSession(split.id, rawName);
    },

    deleteSessions: (ids) => {
      for (const [entry, native] of byAgent(ids))
        entry.store.deleteSessions(native);
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
