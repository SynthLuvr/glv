import { shortenHome, truncateMiddle } from "../format/index.js";
import { prLabel } from "../pr.js";

// GitHub Octicon paths.
const BRANCH_ICON =
  "M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z";
const PR_ICON =
  "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z";
const FOLDER_ICON =
  "M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z";

type GitChipProps = {
  kind: "branch" | "worktree";
  icon: string;
  title: string;
  label: string;
  mono?: boolean;
  compact?: boolean;
  href?: string;
};

const GitChipInner = ({
  icon,
  label,
  mono,
}: {
  icon: string;
  label: string;
  mono: boolean;
}) => (
  <>
    <svg
      class="git-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={icon} />
    </svg>
    <span class={`git-chip-label${mono ? " mono" : ""}`}>{label}</span>
  </>
);

// `compact` swaps the kind-specific class for the shared `git-chip-sm` sizing
// used by the sidebar.
const GitChip = ({
  kind,
  icon,
  title,
  label,
  mono = false,
  compact = false,
  href,
}: GitChipProps) => {
  const cls = `git-chip${compact ? " git-chip-sm" : ` git-chip-${kind}`}`;
  if (href !== undefined)
    return (
      <a
        class={cls}
        href={href}
        hx-get={href}
        hx-target="#detail-pane"
        hx-swap="innerHTML"
        title={title}
      >
        <GitChipInner icon={icon} label={label} mono={mono} />
      </a>
    );
  return (
    <span class={cls} title={title}>
      <GitChipInner icon={icon} label={label} mono={mono} />
    </span>
  );
};

const BranchChip = ({
  branch,
  compact = false,
}: {
  branch: string;
  compact?: boolean;
}) => (
  <GitChip
    kind="branch"
    icon={BRANCH_ICON}
    title={`git branch: ${branch}`}
    label={compact ? truncateMiddle(branch, 24) : branch}
    compact={compact}
  />
);

const WorktreeChip = ({ worktree }: { worktree: string }) => (
  <GitChip
    kind="worktree"
    icon={FOLDER_ICON}
    title={`git worktree: ${worktree} — start a new session here`}
    label={truncateMiddle(shortenHome(worktree), 40)}
    mono
    href={`/sessions/new?working_dir=${encodeURIComponent(worktree)}`}
  />
);

// URL renders instantly from offline detection; the colored state is swapped
// in lazily via htmx, so any failure just leaves a plain link. `compact`
// shrinks the chip for the sidebar and gives the state element a per-session
// id, since the sidebar shows many at once.
const PrChip = ({
  sessionId,
  url,
  compact = false,
}: {
  sessionId: string;
  url: string;
  compact?: boolean;
}) => {
  const stateId = compact ? `sb-pr-state-${sessionId}` : "pr-state";
  // hono/jsx can't emit `::` attributes directly, so spread it.
  const errorHandler = {
    "hx-on::response-error": `this.querySelector('#${stateId}')?.remove()`,
  };
  return (
    <a
      class={`pr-chip${compact ? " pr-chip-sm" : ""}`}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      hx-get={`/sessions/${sessionId}/pr-state?url=${encodeURIComponent(url)}`}
      hx-trigger="load"
      hx-target={`#${stateId}`}
      hx-swap="outerHTML"
      // Override #session-list's inherited hx-push-url="true"; the lazy
      // badge request must not pollute the URL bar on refresh.
      hx-push-url="false"
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
      <span id={stateId} class="pr-state pr-state-loading">
        <span class="pr-dot pr-dot-loading" aria-label="Loading PR status" />
      </span>
    </a>
  );
};

export { BranchChip, PrChip, WorktreeChip };
