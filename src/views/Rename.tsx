import type { Child } from "hono/jsx";
import type { SessionRow } from "../db.js";
import { displayName } from "../format.js";

const icon = (children: Child): Child => (
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
    {children}
  </svg>
);

type RenameContext = "header" | "sidebar";

// Click-to-edit control shared by the transcript header and sidebar cards.
// The view and form are server-rendered; the client toggles `is-editing` and
// htmx swaps this fragment back on submit.
const RenameWrap = ({
  session,
  context,
  target,
  children,
}: {
  session: SessionRow;
  context: RenameContext;
  target: string;
  children?: Child;
}) => (
  <div class={`rename-wrap is-${context}`}>
    <span class="rename-view">
      {children}
      <button
        type="button"
        class="rename-pencil"
        data-action="rename"
        aria-label={`Rename ${displayName(session.name)}`}
        title="Rename session"
      >
        {icon([
          <path d="M12 20h9" />,
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />,
        ])}
      </button>
    </span>
    <form
      class="rename-form"
      hx-post={`/sessions/${session.id}/rename`}
      hx-target={target}
      hx-swap="outerHTML"
    >
      <input
        class="rename-input"
        name="name"
        value={session.name}
        data-original-name={session.name}
        autocomplete="off"
        aria-label="Session name"
      />
      <input type="hidden" name="from" value={context} />
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

// Stable id lets the rename POST swap just the title (plus an OOB sidebar
// refresh) without re-rendering the whole transcript.
const SessionTitleWrap = ({ session }: { session: SessionRow }) => (
  <div id="session-title-wrap">
    <RenameWrap session={session} context="header" target="#session-title-wrap">
      <h2 class="session-title">{displayName(session.name)}</h2>
    </RenameWrap>
  </div>
);

export { RenameWrap, SessionTitleWrap };
