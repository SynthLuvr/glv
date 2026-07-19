import type { SessionRow } from "../db.js";
import {
  displayName,
  fmtRelative,
  shortenHome,
  truncateMiddle,
} from "../format/index.js";
import { prLabel } from "../pr.js";
import { RenameWrap } from "./Rename.js";

// Compact branch + PR indicators for the sidebar. Populated lazily by the
// batched `/sessions/sidebar-meta` endpoint, which returns one out-of-band
// swap fragment per session into each item's `#sidebar-meta-<id>` slot — so a
// list of any size costs one request, not one per item. The PR state badge
// then reuses the existing per-session pr-state endpoint.
const BRANCH_ICON =
  "M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z";
const PR_ICON =
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";

const SidebarBranchChip = ({ branch }: { branch: string }) => (
  <span class="git-chip git-chip-sm" title={`git branch: ${branch}`}>
    <svg
      class="git-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={BRANCH_ICON} />
    </svg>
    <span class="git-chip-label">{truncateMiddle(branch, 24)}</span>
  </span>
);

const SidebarPrChip = ({ id, url }: { id: string; url: string }) => {
  // hono/jsx can't emit `::` attributes directly, so spread it.
  const errorHandler = {
    "hx-on::response-error": `this.querySelector('#sb-pr-state-${id}')?.remove()`,
  };
  return (
    <a
      class="pr-chip pr-chip-sm"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      hx-get={`/sessions/${id}/pr-state?url=${encodeURIComponent(url)}`}
      hx-trigger="load"
      hx-target={`#sb-pr-state-${id}`}
      hx-swap="outerHTML"
      {...errorHandler}
    >
      <svg
        class="pr-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d={PR_ICON} />
      </svg>
      <span class="pr-num">{prLabel(url)}</span>
      <span id={`sb-pr-state-${id}`} class="pr-state pr-state-loading">
        <span class="pr-dot pr-dot-loading" aria-label="Loading PR status" />
      </span>
    </a>
  );
};

type SidebarProps = {
  sessions: SessionRow[];
  selectedId: string | undefined;
  runningIds: Set<string>;
};

const SessionItem = ({
  session,
  selected,
  running,
}: {
  session: SessionRow;
  selected: boolean;
  running: boolean;
}) => {
  const href = `/sessions/${session.id}`;
  return (
    <div
      class={`session-item${selected ? " selected" : ""}`}
      data-session-id={session.id}
      data-running={running ? "" : undefined}
    >
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
  sessions,
  selectedId,
  runningIds,
  oob = false,
}: SidebarProps & { oob?: boolean }) => (
  <div
    id="session-list"
    class="session-list"
    hx-target="#detail-pane"
    hx-swap="innerHTML scrollTop:top"
    hx-push-url="true"
    hx-swap-oob={oob ? "true" : undefined}
  >
    <BulkActionBar />
    <div
      class="sidebar-meta-loader"
      hx-get="/sessions/sidebar-meta"
      hx-trigger="load"
      hx-swap="none"
      aria-hidden="true"
    ></div>
    {sessions.map((session) => (
      <SessionItem
        session={session}
        selected={session.id === selectedId}
        running={runningIds.has(session.id)}
      />
    ))}
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
  selectedId,
  runningIds,
  logout = false,
}: SidebarProps & { logout?: boolean }) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Goose Sessions</h1>
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
        sessions={sessions}
        selectedId={selectedId}
        runningIds={runningIds}
      />
    )}
    <script src="/assets/sidebar.js" defer></script>
  </aside>
);

export { SessionList, Sidebar, SidebarBranchChip, SidebarPrChip };
