import { renderToString } from "hono/jsx/dom/server";
import type { SessionRow } from "../db.js";
import type { ParsedMessage } from "../format/index.js";
import { fmtRelative, shortenHome, truncateMiddle } from "../format/index.js";
import { detectPrUrl, prLabel } from "../pr.js";
import type { RunHandle } from "../runner/index.js";
import { hasContent, MessageView } from "./message-blocks.js";
import { SessionTitleWrap } from "./Rename.js";

const MetaChip = ({
  id,
  label,
  value,
  mono = false,
  title,
}: {
  id?: string;
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
}) => (
  <div id={id} class="meta-chip" title={title ?? value}>
    <span class="meta-label">{label}</span>
    <span class={`meta-value${mono ? " mono" : ""}`}>{value}</span>
  </div>
);

// URL renders instantly from offline detection; the colored state is
// swapped in lazily via htmx. Any failure leaves a plain link.
const PrChip = ({ sessionId, url }: { sessionId: string; url: string }) => {
  // hono/jsx can't emit `::` attributes directly, so spread it.
  const errorHandler = {
    "hx-on::response-error": "this.querySelector('#pr-state')?.remove()",
  };
  return (
    <a
      class="pr-chip"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      hx-get={`/sessions/${sessionId}/pr-state?url=${encodeURIComponent(url)}`}
      hx-trigger="load"
      hx-target="#pr-state"
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
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
      <span class="pr-num">{prLabel(url)}</span>
      <span id="pr-state" class="pr-state pr-state-loading">
        <span
          class="pr-dot pr-dot-loading"
          aria-label="Loading PR status"
        ></span>
      </span>
    </a>
  );
};

// Branch + worktree context resolved lazily from local git, shown alongside
// the PR chip. The branch comes from the worktree block the session runs in,
// so it never requires re-scanning the transcript.
const BranchChip = ({ branch }: { branch: string }) => (
  <span class="git-chip git-chip-branch" title={`git branch: ${branch}`}>
    <svg
      class="git-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
    <span class="git-chip-label">{branch}</span>
  </span>
);

const WorktreeChip = ({ worktree }: { worktree: string }) => (
  <span class="git-chip git-chip-worktree" title={`git worktree: ${worktree}`}>
    <svg
      class="git-icon"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
    <span class="git-chip-label mono">
      {truncateMiddle(shortenHome(worktree), 40)}
    </span>
  </span>
);

const TranscriptHeader = ({
  session,
  prUrl,
}: {
  session: SessionRow;
  prUrl?: string;
}) => (
  <header class="session-header">
    <div class="session-header-top">
      <SessionTitleWrap session={session} />
      <button
        type="button"
        class="archive-btn"
        hx-post={`/sessions/${session.id}/archive`}
        hx-target="#detail-pane"
        hx-swap="innerHTML"
        hx-confirm="Archive this session? It will be hidden from the sidebar."
      >
        Archive
      </button>
    </div>
    <div class="session-meta">
      <MetaChip label="ID" value={session.id} mono />
      <MetaChip
        label="Working dir"
        value={truncateMiddle(shortenHome(session.working_dir), 48)}
        mono
        title={session.working_dir}
      />
      <MetaChip
        label="Created"
        value={fmtRelative(session.created_at)}
        title={session.created_at}
      />
      <MetaChip
        id="meta-updated"
        label="Updated"
        value={fmtRelative(session.updated_at)}
        title={session.updated_at}
      />
      {prUrl !== undefined && <PrChip sessionId={session.id} url={prUrl} />}
      <span
        id="git-info"
        hx-get={`/sessions/${session.id}/git-info`}
        hx-trigger="load"
        hx-swap="outerHTML"
      ></span>
    </div>
  </header>
);

const SubmittedPrompt = ({ prompt }: { prompt: string }) => (
  <article class="message prompt submitted-prompt">
    <div class="message-head">
      <span class="tag prompt">▸ PROMPT</span>
    </div>
    <div class="message-body">
      <p class="message-text">{prompt}</p>
    </div>
  </article>
);

const renderPromptCard = (prompt: string): string =>
  renderToString(<SubmittedPrompt prompt={prompt} />);

const QueuedPrompt = ({ prompt }: { prompt: string }) => (
  <article class="message prompt queued-prompt">
    <div class="message-head">
      <span class="tag prompt">▸ PROMPT</span>
      <span class="queued-badge">⏳ Queued</span>
    </div>
    <div class="message-body">
      <p class="message-text">{prompt}</p>
    </div>
  </article>
);

const isRunActive = (run: RunHandle | undefined): boolean =>
  run !== undefined && (run.status === "queued" || run.status === "running");

const PromptBar = ({
  sessionId,
  run,
}: {
  sessionId: string;
  run?: RunHandle;
}) => {
  const busy = isRunActive(run);
  const pendingCount = run?.pendingPrompts.length ?? 0;
  return (
    <form
      class="prompt-bar"
      hx-post={`/sessions/${sessionId}/prompt`}
      hx-target="#detail-pane"
      hx-swap="innerHTML"
    >
      {run?.status === "queued" && run.queuePosition !== undefined && (
        <p class="status-hint queued" aria-live="polite">
          Queued, waiting… (position {run.queuePosition})
        </p>
      )}
      {run?.status === "running" && (
        <p class="status-hint running" aria-live="polite">
          Running…
          {pendingCount > 0 &&
            ` (${pendingCount} prompt${pendingCount > 1 ? "s" : ""} queued next)`}
        </p>
      )}
      {run?.status === "error" && run.error !== undefined && (
        <p class="status-hint error" aria-live="polite">
          {run.error}
        </p>
      )}
      <div class="prompt-input-row">
        <textarea
          name="prompt"
          placeholder={busy ? "Queue a follow-up prompt…" : "Ask goose…"}
          class="prompt-input"
          rows={2}
        />
        {busy ? (
          <>
            <button type="submit" class="queue-btn">
              Queue
            </button>
            <button
              type="button"
              class="stop-btn"
              hx-post={`/sessions/${sessionId}/stop`}
              hx-target="#detail-pane"
              hx-swap="innerHTML"
            >
              Stop
            </button>
          </>
        ) : (
          <button type="submit" class="send-btn">
            Send
          </button>
        )}
      </div>
    </form>
  );
};

const Transcript = ({
  session,
  messages,
  run,
  prompt,
}: {
  session: SessionRow;
  messages: ParsedMessage[];
  run?: RunHandle;
  prompt?: string;
}) => {
  const visible = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => hasContent(entry.message));
  const isEmpty = visible.length === 0 && prompt === undefined;
  const prUrl = detectPrUrl(messages);
  return (
    <div
      class="detail-inner"
      data-session-id={session.id}
      data-run-status={run?.status}
    >
      <TranscriptHeader session={session} prUrl={prUrl} />
      {isEmpty ? (
        <p class="empty">This session has no messages.</p>
      ) : (
        <div id="messages">
          {visible.map((entry) => (
            <MessageView message={entry.message} index={entry.index} />
          ))}
        </div>
      )}
      {prompt !== undefined && <SubmittedPrompt prompt={prompt} />}
      {isRunActive(run) && <div id="live-output" class="live-output"></div>}
      {run !== undefined && run.pendingPrompts.length > 0 && (
        <div id="queued-prompts" class="queued-prompts">
          {run.pendingPrompts.map((p) => (
            <QueuedPrompt prompt={p} />
          ))}
          <button
            type="button"
            class="clear-queue-btn"
            hx-post={`/sessions/${session.id}/queue/cancel`}
            hx-target="#detail-pane"
            hx-swap="innerHTML"
          >
            Clear all queued
          </button>
        </div>
      )}
      <PromptBar sessionId={session.id} run={run} />
    </div>
  );
};

export { BranchChip, renderPromptCard, Transcript, WorktreeChip };
