import type { SessionRow } from "../db.js";
import {
  displayName,
  fmtRelative,
  shortenHome,
  truncateMiddle,
} from "../format/index.js";
import type { ListEntry } from "../groups/model.js";
import { icon, RenameWrap } from "./Rename.js";

type SidebarProps = {
  sessions: SessionRow[];
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
};

const SessionItem = ({
  session,
  selected,
  running,
  inGroup = false,
}: {
  session: SessionRow;
  selected: boolean;
  running: boolean;
  inGroup?: boolean;
}) => {
  const href = `/sessions/${session.id}`;
  return (
    <div
      class={`session-item${selected ? " selected" : ""}${inGroup ? " in-group" : ""}`}
      data-session-id={session.id}
      data-running={running ? "" : undefined}
    >
      <span
        class="session-drag-handle"
        title="Drag to group"
        aria-label={`Drag ${displayName(session.name)} to group`}
      >
        {icon([
          <circle cx="9" cy="6" r="1.2" />,
          <circle cx="9" cy="12" r="1.2" />,
          <circle cx="9" cy="18" r="1.2" />,
          <circle cx="15" cy="6" r="1.2" />,
          <circle cx="15" cy="12" r="1.2" />,
          <circle cx="15" cy="18" r="1.2" />,
        ])}
      </span>
      <label class="session-check-wrap" title="Select for bulk actions">
        <input
          type="checkbox"
          class="session-check"
          name="id"
          value={session.id}
          aria-label={`Select ${displayName(session.name)}`}
        />
      </label>
      <div class="session-main">
        <a class="session-link" href={href} hx-get={href}>
          <span class="session-name">{displayName(session.name)}</span>
          <span class="session-sub">
            <time title={session.updated_at}>
              {fmtRelative(session.updated_at)}
            </time>
            <span
              class="run-indicator"
              title={running ? "Session is running" : "Session idle"}
            >
              <span class="run-dot" />
            </span>
          </span>
          <span class="session-dir" title={session.working_dir}>
            {truncateMiddle(shortenHome(session.working_dir), 42)}
          </span>
        </a>
        <span
          id={`sidebar-meta-${session.id}`}
          class="session-meta-tags"
        ></span>
      </div>
      <RenameWrap session={session} context="sidebar" target="#session-list" />
    </div>
  );
};

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

const BulkActionBar = () => (
  <div id="bulk-bar" class="bulk-bar" hidden={true}>
    <button
      type="button"
      class="bulk-toggle-btn"
      id="bulk-toggle"
      data-bulk-action="select-all"
      title="Select or deselect every session"
    >
      Select all
    </button>
    <span class="bulk-count-wrap">
      <strong id="bulk-count">0</strong> selected
    </span>
    <button
      type="button"
      class="bulk-clear-btn"
      data-bulk-action="clear"
      title="Clear the current selection"
    >
      Clear
    </button>
    <button
      type="button"
      class="bulk-archive-btn"
      hx-post="/sessions/archive"
      hx-include="closest #session-list"
      hx-target="#session-list"
      hx-swap="outerHTML"
      hx-confirm="Archive the selected sessions? They will be hidden from the sidebar."
    >
      Archive
    </button>
  </div>
);

// Rendered as `<div id="session-list">` so it can be swapped out-of-band by
// htmx (re-rendered with the new selection) without reloading the page.
const SessionList = ({
  entries,
  selectedId,
  runningIds,
  oob = false,
}: {
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  oob?: boolean;
}) => (
  <div
    id="session-list"
    class="session-list"
    hx-target="#detail-pane"
    hx-swap="innerHTML"
    hx-push-url="true"
    hx-swap-oob={oob ? "true" : undefined}
  >
    <BulkActionBar />
    <div
      class="sidebar-meta-loader"
      hx-get="/sessions/sidebar-meta"
      hx-trigger="load"
      hx-swap="none"
      hx-push-url="false"
      aria-hidden="true"
    ></div>
    {entries.map((entry) =>
      entry.kind === "session" ? (
        <SessionItem
          session={entry.session}
          selected={entry.session.id === selectedId}
          running={runningIds.has(entry.session.id)}
        />
      ) : (
        <GroupEntry
          entry={entry}
          selectedId={selectedId}
          runningIds={runningIds}
        />
      ),
    )}
  </div>
);

const ThemeToggle = () => (
  <button
    type="button"
    class="theme-toggle"
    aria-label="Toggle dark mode"
    title="Toggle dark / light theme"
  >
    <svg
      class="icon-moon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
    <svg
      class="icon-sun"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  </button>
);

const NewSessionButton = () => (
  <a
    class="new-session-btn"
    href="/sessions/new"
    hx-get="/sessions/new"
    hx-target="#detail-pane"
    hx-swap="innerHTML"
    title="Start a new session"
    aria-label="Start a new session"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  </a>
);

const LogoutButton = () => (
  <form action="/auth/logout" method="post" class="logout-form">
    <button
      type="submit"
      class="logout-btn"
      aria-label="Log out"
      title="Log out"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" y1="12" x2="9" y2="12" />
      </svg>
    </button>
  </form>
);

const Sidebar = ({
  sessions,
  entries,
  selectedId,
  runningIds,
  logout = false,
}: SidebarProps & { logout?: boolean }) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Sessions</h1>
      <span class="session-count">{sessions.length}</span>
      <NewSessionButton />
      <ThemeToggle />
      {logout && <LogoutButton />}
    </div>
    {sessions.length === 0 ? (
      <p class="empty">
        No sessions found.{" "}
        <a
          href="/sessions/new"
          hx-get="/sessions/new"
          hx-target="#detail-pane"
          hx-swap="innerHTML"
        >
          Start a new session
        </a>
        .
      </p>
    ) : (
      <SessionList
        entries={entries}
        selectedId={selectedId}
        runningIds={runningIds}
      />
    )}
    <script src="/assets/sidebar.js" defer></script>
    <script src="/assets/groups.js" defer></script>
  </aside>
);

export { SessionList, Sidebar };
