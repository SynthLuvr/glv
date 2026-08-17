import type { ListEntry } from "../../glv/groups/model.js";
import { icon } from "./Rename.js";
import { SessionItem } from "./SessionItem.js";

const GroupRenameWrap = ({
  groupId,
  name,
  target,
}: {
  groupId: string;
  name: string;
  target: string;
}) => (
  <div class="rename-wrap is-sidebar group-rename-wrap">
    <span class="rename-view">
      <span class="group-name">{name}</span>
      <button
        type="button"
        class="rename-pencil"
        data-action="rename"
        aria-label={`Rename ${name}`}
        title="Rename group"
      >
        {icon([
          <path d="M12 20h9" />,
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
        ])}
      </button>
    </span>
    <form
      class="rename-form"
      hx-post={`/groups/${groupId}/rename`}
      hx-target={target}
      hx-swap="outerHTML"
    >
      <input
        class="rename-input"
        name="name"
        value={name}
        data-original-name={name}
        autocomplete="off"
        aria-label="Group name"
      />
      <button
        type="submit"
        class="rename-confirm"
        aria-label="Save name"
        title="Save"
      >
        {icon(<path d="M20 6 9 17l-5-5" />)}
      </button>
      <button
        type="button"
        class="rename-cancel"
        data-action="cancel-rename"
        aria-label="Cancel rename"
        title="Cancel"
      >
        {icon([<path d="M18 6 6 18" />, <path d="m6 6 12 12" />])}
      </button>
    </form>
  </div>
);

const GroupHeader = ({
  groupId,
  groupName,
  memberCount,
  running,
  target,
}: {
  groupId: string;
  groupName: string;
  memberCount: number;
  running: boolean;
  target: string;
}) => (
  <div
    class="group-header"
    data-group-id={groupId}
    data-running={running ? "" : undefined}
  >
    <button
      type="button"
      class="group-toggle"
      data-action="toggle-group"
      data-group-id={groupId}
      aria-expanded="true"
      title="Collapse / expand"
    >
      {icon(<polyline points="6 9 12 15 18 9" />)}
    </button>
    <GroupRenameWrap groupId={groupId} name={groupName} target={target} />
    <span class="group-count" title={`${memberCount} sessions`}>
      {memberCount}
    </span>
    <span
      class="run-indicator"
      title={running ? "A session in this group is running" : undefined}
    >
      <span class="run-dot" />
      {running && <span class="sr-only">Running</span>}
    </span>
    <button
      type="button"
      class="group-archive-btn"
      hx-post={`/groups/${groupId}/archive`}
      hx-target="#session-list"
      hx-swap="outerHTML"
      hx-confirm={`Archive all ${memberCount} session${memberCount > 1 ? "s" : ""} in this group? They will be hidden from the sidebar.`}
      title="Archive group"
      aria-label={`Archive ${groupName}`}
    >
      {icon([
        <polyline points="21 8 21 21 3 21 3 8" />,
        <rect x="1" y="3" width="22" height="5" />,
        <line x1="10" y1="12" x2="14" y2="12" />,
      ])}
    </button>
  </div>
);

const GroupEntry = ({
  entry,
  selectedId,
  runningIds,
}: {
  entry: Extract<ListEntry, { kind: "group" }>;
  selectedId: string | undefined;
  runningIds: Set<string>;
}) => {
  const groupRunning = entry.members.some((member) =>
    runningIds.has(member.id),
  );
  return (
    <div class="session-group" data-group-id={entry.groupId}>
      <GroupHeader
        groupId={entry.groupId}
        groupName={entry.groupName}
        memberCount={entry.memberCount}
        running={groupRunning}
        target="#session-list"
      />
      <div class="group-members">
        {entry.members.map((session) => (
          <SessionItem
            session={session}
            selected={session.id === selectedId}
            running={runningIds.has(session.id)}
            inGroup
          />
        ))}
      </div>
    </div>
  );
};

export { GroupEntry };
