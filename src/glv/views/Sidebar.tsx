import type { ListEntry } from "../groups/model.js";
import type { SessionRow } from "../sessions.js";
import { GroupEntry } from "./GroupEntry.js";
import { SessionItem } from "./SessionItem.js";
import {
  BrowseFilesButton,
  BulkActionBar,
  LogoutButton,
  NewSessionButton,
  ThemeToggle,
} from "./SidebarControls.js";

type SidebarProps = {
  sessions: SessionRow[];
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
};

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
      hx-target="#session-list"
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
      <BrowseFilesButton />
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
          hx-push-url="true"
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
