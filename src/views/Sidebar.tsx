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
      <input
        type="checkbox"
        class="session-check"
        name="id"
        value={session.id}
        aria-label={`Select ${displayName(session.name)}`}
      />
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
    <span class="bulk-count-wrap">
      <strong id="bulk-count">0</strong> selected
    </span>
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

// htmx serializes the checked boxes via `hx-include`, but the live "N selected"
// count and showing/hiding the action bar are inherently client-side. Delegating
// on `document` keeps the handler alive across the out-of-band sidebar swaps htmx
// performs; the bar is re-rendered hidden by the server on every list refresh,
// so navigating to another session always resets the selection.
const SELECTION_SCRIPT = raw(`
  document.addEventListener("change", (e) => {
    const target = e.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.classList.contains("session-check")
    )
      return;
    const checked = document.querySelectorAll(".session-check:checked");
    const bar = document.getElementById("bulk-bar");
    const count = document.getElementById("bulk-count");
    if (count !== null) count.textContent = String(checked.length);
    if (bar !== null) bar.hidden = checked.length === 0;
  });
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
    <script>{SELECTION_SCRIPT}</script>
  </aside>
);

export { SessionList, Sidebar };
