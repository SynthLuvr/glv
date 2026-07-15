import { raw } from "hono/utils/html";
import type { SessionRow } from "../db.js";
import {
  displayName,
  fmtRelative,
  fmtTokens,
  truncateMiddle,
} from "../format.js";

type SidebarProps = {
  sessions: SessionRow[];
  selectedId: string | undefined;
};

const SessionItem = ({
  session,
  selected,
}: {
  session: SessionRow;
  selected: boolean;
}) => {
  const href = `/sessions/${session.id}`;
  return (
    <div class={`session-item${selected ? " selected" : ""}`}>
      <label class="session-check-wrap" title="Select for bulk actions">
        <input
          type="checkbox"
          class="session-check"
          name="id"
          value={session.id}
          aria-label={`Select ${displayName(session.name)}`}
        />
      </label>
      <a class="session-link" href={href} hx-get={href}>
        <span class="session-name">{displayName(session.name)}</span>
        <span class="session-sub">
          <time title={session.updated_at}>
            {fmtRelative(session.updated_at)}
          </time>
          {session.provider_name !== null && (
            <span class="provider-badge">{session.provider_name}</span>
          )}
          {session.total_tokens !== null && (
            <span class="token-count">{fmtTokens(session.total_tokens)}</span>
          )}
        </span>
        <span class="session-dir" title={session.working_dir}>
          {truncateMiddle(session.working_dir, 42)}
        </span>
      </a>
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
    {sessions.map((session) => (
      <SessionItem session={session} selected={session.id === selectedId} />
    ))}
  </div>
);

// Event delegation on `document` survives the out-of-band sidebar swaps that
// archiving triggers. Navigation swaps only the detail pane, so an in-progress
// selection is preserved between page transitions.
const SIDEBAR_SCRIPT = raw(`
  const updateBulkBar = () => {
    const checks = [...document.querySelectorAll(".session-check")];
    const checkedCount = checks.filter((c) => c.checked).length;
    const allChecked = checks.length > 0 && checkedCount === checks.length;
    const count = document.getElementById("bulk-count");
    if (count) count.textContent = String(checkedCount);
    const bar = document.getElementById("bulk-bar");
    if (bar) bar.hidden = checkedCount === 0;
    const toggle = document.getElementById("bulk-toggle");
    if (toggle) toggle.textContent = allChecked ? "Deselect all" : "Select all";
  };

  document.addEventListener("change", (e) => {
    if (
      e.target instanceof HTMLInputElement &&
      e.target.classList.contains("session-check")
    )
      updateBulkBar();
  });

  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target : null;

    const btn = el?.closest("[data-bulk-action]");
    if (btn) {
      e.preventDefault();
      const checks = [...document.querySelectorAll(".session-check")];
      const allChecked = checks.length > 0 && checks.every((c) => c.checked);
      if (btn.dataset.bulkAction === "select-all")
        checks.forEach((c) => (c.checked = !allChecked));
      else
        checks.forEach((c) => (c.checked = false));
      updateBulkBar();
      return;
    }

    // Navigation doesn't re-render the sidebar, so the active-row highlight
    // is maintained client-side.
    const item = el?.closest(".session-link")?.closest(".session-item");
    if (item) {
      document
        .querySelectorAll(".session-item.selected")
        .forEach((node) => node.classList.remove("selected"));
      item.classList.add("selected");
    }
  });

  updateBulkBar();
`);

const Sidebar = ({ sessions, selectedId }: SidebarProps) => (
  <aside class="sidebar">
    <div class="sidebar-head">
      <h1>Goose Sessions</h1>
      <span class="session-count">{sessions.length}</span>
    </div>
    {sessions.length === 0 ? (
      <p class="empty">No sessions found.</p>
    ) : (
      <SessionList sessions={sessions} selectedId={selectedId} />
    )}
    <script>{SIDEBAR_SCRIPT}</script>
  </aside>
);

export { SessionList, Sidebar };
