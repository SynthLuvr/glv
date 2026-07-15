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

// The custom-styled checks are pure presentation over a real checkbox, so htmx
// still serializes the selection via `hx-include`. The live "N selected" count,
// the Select-all / Clear toggles and the active-row highlight are inherently
// client-side. Delegating on `document` keeps the handlers alive across the
// out-of-band swaps htmx performs on archive. Plain navigation only swaps the
// detail pane, so an in-progress selection is preserved; the bar is re-rendered
// hidden by the server whenever the list does refresh (after archiving).
const SIDEBAR_SCRIPT = raw(`
  const updateBulkBar = () => {
    const checks = Array.from(document.querySelectorAll(".session-check"));
    const checkedCount = checks.filter((c) => c.checked).length;
    const bar = document.getElementById("bulk-bar");
    const count = document.getElementById("bulk-count");
    const toggle = document.getElementById("bulk-toggle");
    const allChecked = checks.length > 0 && checkedCount === checks.length;
    if (count !== null) count.textContent = String(checkedCount);
    if (bar !== null) bar.hidden = checkedCount === 0;
    if (toggle !== null)
      toggle.textContent = allChecked ? "Deselect all" : "Select all";
  };

  document.addEventListener("change", (e) => {
    const target = e.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.classList.contains("session-check")
    )
      return;
    updateBulkBar();
  });

  document.addEventListener("click", (e) => {
    const el = e.target instanceof Element ? e.target : null;

    // Select-all / Clear toolbar buttons.
    const btn = el === null ? null : el.closest("[data-bulk-action]");
    if (btn !== null) {
      e.preventDefault();
      const checks = Array.from(document.querySelectorAll(".session-check"));
      const allChecked = checks.length > 0 && checks.every((c) => c.checked);
      if (btn.dataset.bulkAction === "select-all")
        checks.forEach((c) => { c.checked = !allChecked; });
      else if (btn.dataset.bulkAction === "clear")
        checks.forEach((c) => { c.checked = false; });
      updateBulkBar();
      return;
    }

    // Navigation: move the active-row highlight to the clicked session. The
    // sidebar is not re-rendered on navigation (preserving any selection), so
    // the highlight is maintained here instead of server-side.
    const link = el === null ? null : el.closest(".session-link");
    if (link !== null) {
      const item = link.closest(".session-item");
      if (item !== null) {
        document
          .querySelectorAll(".session-item.selected")
          .forEach((node) => node.classList.remove("selected"));
        item.classList.add("selected");
      }
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
