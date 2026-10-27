import type { NestedEntry } from "../groups/model.js";
import { subtreeSize } from "../groups/model.js";
import { icon } from "./Rename.js";
import { SessionItem } from "./SessionItem.js";

// Renders one nested level of an orchestrator subtree (#385): the
// parent's own session item (fully interactive — open, rename, drag)
// with a collapse toggle and the subtree's size, and its workers
// nested beneath like group members. The wrapper reuses the group
// markup (.session-group + .group-toggle + .group-members) so the
// groups script's collapse/expand and its persisted state apply
// unchanged; the header deliberately does not reuse .group-header, so a
// drag onto it reads as a drop on the parent session, not on a group.
const NestedMembers = ({
  entries,
  selectedId,
  runningIds,
}: {
  entries: NestedEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
}) => (
  <div class="group-members">
    {entries.map((entry) =>
      entry.kind === "session" ? (
        <SessionItem
          session={entry.session}
          selected={entry.session.id === selectedId}
          running={runningIds.has(entry.session.id)}
          inGroup
        />
      ) : (
        <OrchestratorEntry
          entry={entry}
          selectedId={selectedId}
          runningIds={runningIds}
        />
      ),
    )}
  </div>
);

const OrchestratorEntry = ({
  entry,
  selectedId,
  runningIds,
}: {
  entry: Extract<NestedEntry, { kind: "orchestrator" }>;
  selectedId: string | undefined;
  runningIds: Set<string>;
}) => (
  <div class="session-group orchestrator-group" data-group-id={entry.parent.id}>
    <div class="orchestrator-header">
      <button
        type="button"
        class="group-toggle"
        data-action="toggle-group"
        data-group-id={entry.parent.id}
        aria-expanded="true"
        title="Collapse / expand"
      >
        {icon(<polyline points="6 9 12 15 18 9" />)}
      </button>
      <SessionItem
        session={entry.parent}
        selected={entry.parent.id === selectedId}
        running={runningIds.has(entry.parent.id)}
      />
      <span
        class="group-count"
        title={`${subtreeSize(entry) - 1} launched session${
          subtreeSize(entry) === 2 ? "" : "s"
        }`}
      >
        {subtreeSize(entry) - 1}
      </span>
    </div>
    <NestedMembers
      entries={entry.children}
      selectedId={selectedId}
      runningIds={runningIds}
    />
  </div>
);

export { OrchestratorEntry };
