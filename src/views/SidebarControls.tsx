const BulkActionBar = () => (
  <div id="bulk-bar" class="bulk-bar" hidden={true}>
    <button
      type="button"
      class="bulk-toggle-btn"
      id="bulk-toggle"
      data-bulk-action="select-all"
      title="Select or deselect every session"
      aria-pressed="false"
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

const ThemeToggle = () => (
  <button
    type="button"
    class="theme-toggle"
    aria-label="Toggle dark mode"
    title="Toggle dark / light theme"
    aria-pressed="false"
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

const BrowseFilesButton = () => (
  <a
    class="browse-files-btn"
    href="/browse"
    hx-get="/browse"
    hx-target="#detail-pane"
    hx-swap="innerHTML"
    hx-push-url="true"
    title="Browse files in your home directory"
    aria-label="Browse files"
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
      <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2z" />
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

export {
  BrowseFilesButton,
  BulkActionBar,
  LogoutButton,
  NewSessionButton,
  ThemeToggle,
};
