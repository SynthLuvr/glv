import type { SessionRow } from "../db.js";
import {
  displayName,
  fmtRelative,
  shortenHome,
  truncateMiddle,
} from "../format/index.js";
import { icon, RenameWrap } from "./Rename.js";

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

export { SessionItem };
