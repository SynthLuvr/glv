import { renderToString } from "hono/jsx/dom/server";
import type { ParsedMessage, ToolRun } from "../../glv/format/index.js";
import {
  fmtRelative,
  pendingTool,
  queuedSuffix,
  shortenHome,
  toolRunText,
  truncateMiddle,
  unsafeForkCutoffs,
} from "../../glv/format/index.js";
import { detectPrUrl } from "../../glv/pr.js";
import type { RunHandle } from "../../glv/runner/index.js";
import type { SessionRow } from "../../glv/sessions.js";
import { CronChip, PrChip } from "../../glv/views/chips.js";
import { LocationButton, LocationFields } from "../../glv/views/location.js";
import { SessionTitleWrap } from "../../glv/views/Rename.js";
import { PaperclipButton, UploadFields } from "../../glv/views/uploads.js";
import { CopyableText, hasContent, MessageView } from "./message-blocks.js";

// Icons are toggled via the `.copied` class that ui.ts's delegated handler
// adds after a clipboard write — no per-button wiring needed.
const MetaCopyButton = ({ value, label }: { value: string; label: string }) => {
  const action = `Copy ${label.toLowerCase()}`;
  return (
    <button
      type="button"
      class="copy-value-btn"
      data-copy={value}
      title={action}
      aria-label={action}
    >
      <svg
        class="icon-copy"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
      <svg
        class="icon-check"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </button>
  );
};

const MetaChip = ({
  id,
  label,
  value,
  mono = false,
  title,
  copyValue,
}: {
  id?: string;
  label: string;
  value: string;
  mono?: boolean;
  title?: string;
  copyValue?: string;
}) => (
  <div id={id} class="meta-chip" title={title ?? value}>
    <span class="meta-label">{label}</span>
    <span class={`meta-value${mono ? " mono" : ""}`}>{value}</span>
    {copyValue !== undefined && (
      <MetaCopyButton label={label} value={copyValue} />
    )}
  </div>
);

// "⋯" trigger beside Archive opening the session action sheet: the panel
// is server-rendered hidden and actions.js toggles `is-open` (dropdown on
// desktop, bottom sheet on mobile). Delete is deliberately three taps —
// open, "Delete permanently", confirm — while Archive stays two.
const SessionActionMenu = ({ session }: { session: SessionRow }) => (
  <div class="session-menu">
    <button
      type="button"
      class="session-menu-toggle"
      data-action="toggle-session-menu"
      aria-haspopup="menu"
      aria-expanded="false"
      aria-controls={`session-menu-${session.id}`}
      aria-label="More session actions"
      title="More session actions"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <circle cx="12" cy="5" r="1.7" />
        <circle cx="12" cy="12" r="1.7" />
        <circle cx="12" cy="19" r="1.7" />
      </svg>
    </button>
    {/* Invisible on desktop (outside-click catcher); a scrim behind the
        mobile bottom sheet. */}
    <div
      class="session-menu-backdrop"
      data-action="close-session-menu"
      aria-hidden="true"
    ></div>
    <div
      class="session-menu-panel"
      role="menu"
      id={`session-menu-${session.id}`}
      aria-label="Session actions"
    >
      <button
        type="button"
        role="menuitem"
        class="session-menu-item session-menu-fork"
        hx-post={`/sessions/${session.id}/fork`}
        hx-target="#detail-pane"
        hx-swap="innerHTML"
      >
        Fork session
      </button>
      <button
        type="button"
        role="menuitem"
        class="session-menu-item session-menu-delete"
        hx-post={`/sessions/${session.id}/delete`}
        hx-target="#detail-pane"
        hx-swap="innerHTML"
        hx-confirm="Permanently delete this session? This cannot be undone — the transcript and every record of it will be erased."
      >
        Delete permanently
      </button>
      {/* Mobile-sheet dismiss row; hidden on the desktop dropdown, where
          tapping outside or pressing Escape closes it. */}
      <button
        type="button"
        role="menuitem"
        class="session-menu-item session-menu-cancel"
        data-action="close-session-menu"
      >
        Cancel
      </button>
    </div>
  </div>
);

const TranscriptHeader = ({
  session,
  prUrl,
  cronJob,
}: {
  session: SessionRow;
  prUrl?: string;
  /** Name of the scheduled job that started this session, if any. */
  cronJob?: string;
}) => (
  <header class="session-header">
    <div class="session-header-top">
      <SessionTitleWrap session={session} />
      <div class="session-header-actions">
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
        <SessionActionMenu session={session} />
      </div>
    </div>
    <div class="session-meta">
      <MetaChip label="ID" value={session.id} mono />
      {cronJob !== undefined && <CronChip jobName={cronJob} />}
      {session.model !== null && (
        <MetaChip label="Model" value={session.model} mono />
      )}
      <MetaChip
        label="Working dir"
        value={truncateMiddle(shortenHome(session.working_dir), 48)}
        mono
        title={session.working_dir}
        copyValue={session.working_dir}
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

// Tags the server-rendered prompt card so the live stream can remove it once
// it replays started prompts, preventing a duplicate.
const SubmittedPrompt = ({
  prompt,
  active = false,
}: {
  prompt: string;
  active?: boolean;
}) => (
  <article
    class="message prompt submitted-prompt"
    data-active-prompt={active || undefined}
  >
    <div class="message-head">
      <span class="tag prompt">▸ PROMPT</span>
    </div>
    <div class="message-body">
      <CopyableText text={prompt} />
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
      <CopyableText text={prompt} />
    </div>
  </article>
);

const isRunActive = (run: RunHandle | undefined): boolean =>
  run !== undefined && (run.status === "queued" || run.status === "running");

const PromptBar = ({
  agentName,
  sessionId,
  run,
  uploadError,
  pendingTool: tool,
  focusPrompt,
}: {
  agentName: string;
  sessionId: string;
  run?: RunHandle;
  uploadError?: string;
  /** In-flight tool call derived from the persisted request row, if any. */
  pendingTool?: ToolRun;
  /** Focus the textarea when the bar lands via an htmx swap (a fresh
   * fork waits on its first prompt). */
  focusPrompt?: boolean;
}) => {
  const busy = isRunActive(run);
  const pendingCount = run?.pendingPrompts.length ?? 0;
  return (
    <form
      class="prompt-bar"
      data-prompt-bar
      data-upload-form
      hx-post={`/sessions/${sessionId}/prompt`}
      hx-target="#detail-pane"
      hx-swap="innerHTML"
      hx-encoding="multipart/form-data"
    >
      {run?.status === "queued" && run.queuePosition !== undefined && (
        <p class="status-hint queued" aria-live="polite">
          Queued, waiting… (position {run.queuePosition})
        </p>
      )}
      {run?.status === "running" && (
        <p
          class="status-hint running"
          aria-live="polite"
          data-tool-running={tool !== undefined ? "" : undefined}
        >
          {tool !== undefined ? toolRunText(tool) : "Running…"}
          {queuedSuffix(pendingCount)}
        </p>
      )}
      {run?.status === "error" && run.error !== undefined && (
        <p class="status-hint error" aria-live="polite">
          {run.error}
        </p>
      )}
      {uploadError !== undefined && (
        <p class="status-hint error" aria-live="polite">
          {uploadError}
        </p>
      )}
      <UploadFields />
      <LocationFields />
      <div class="prompt-input-row">
        <textarea
          name="prompt"
          placeholder={busy ? "Queue a follow-up prompt…" : `Ask ${agentName}…`}
          class="prompt-input"
          rows={2}
          aria-label={busy ? "Queue a follow-up prompt" : "Follow-up prompt"}
          autofocus={focusPrompt ? true : undefined}
        />
        <PaperclipButton compact />
        <LocationButton compact />
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
  agentName,
  session,
  messages,
  run,
  prompt,
  uploadError,
  cronJob,
  focusPrompt,
}: {
  agentName: string;
  session: SessionRow;
  messages: ParsedMessage[];
  run?: RunHandle;
  prompt?: string;
  uploadError?: string;
  /** Name of the scheduled job that started this session, if any. */
  cronJob?: string;
  /** Focus the prompt bar when this transcript renders (a fresh fork). */
  focusPrompt?: boolean;
}) => {
  const visible = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => hasContent(entry.message));
  const isEmpty = visible.length === 0 && prompt === undefined;
  const prUrl = detectPrUrl(messages);
  // Cutoffs that would strand a tool call without its result — the
  // per-message fork buttons render disabled at exactly these indexes.
  const unsafeCutoffs = unsafeForkCutoffs(messages);
  // Only meaningful while the run is live: an unanswered request row in an
  // idle session is stale history, not something the bar should name.
  const tool = run?.status === "running" ? pendingTool(messages) : undefined;
  return (
    <div
      class="detail-inner"
      data-session-id={session.id}
      data-run-status={run?.status}
      data-cursor={String(messages.length)}
    >
      <TranscriptHeader session={session} prUrl={prUrl} cronJob={cronJob} />
      {/* Always present so the tail stream can append; the empty placeholder
        is a sibling the client clears once content arrives. */}
      <div id="messages">
        {visible.map((entry) => (
          <MessageView
            message={entry.message}
            index={entry.index}
            sessionId={session.id}
            forkUnsafe={unsafeCutoffs.has(entry.index)}
          />
        ))}
      </div>
      {isEmpty && (
        <p id="no-messages" class="empty">
          This session has no messages.
        </p>
      )}
      {prompt !== undefined && <SubmittedPrompt prompt={prompt} active />}
      {isRunActive(run) && <div id="live-tail" class="live-tail"></div>}
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
      <PromptBar
        agentName={agentName}
        sessionId={session.id}
        run={run}
        uploadError={uploadError}
        pendingTool={tool}
        focusPrompt={focusPrompt}
      />
    </div>
  );
};

export { PromptBar, renderPromptCard, Transcript };
