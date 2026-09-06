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

// Rendered as `<div id="session-list">` so htmx can swap it back in after
// mutations (directly, or out-of-band alongside a detail swap) without
// reloading the page.
const SessionList = ({
  entries,
  selectedId,
  runningIds,
  oob = false,
  count,
}: {
  entries: ListEntry[];
  selectedId: string | undefined;
  runningIds: Set<string>;
  oob?: boolean;
  /** Total session count, swapped out-of-band into #session-count. Every
   * htmx-served list passes it; the initial full-page render does not (the
   * sidebar head already carries the fresh value). */
  count?: number;
}) => (
  <>
    {count !== undefined && (
      <span id="session-count" class="session-count" hx-swap-oob="true">
        {count}
      </span>
    )}
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
  </>
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
      <span id="session-count" class="session-count">
        {sessions.length}
      </span>
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
