import { renderToString } from "hono/jsx/dom/server";
import type { SessionRow } from "../db.js";
import type { ParsedMessage } from "../format/index.js";
import { fmtRelative, shortenHome, truncateMiddle } from "../format/index.js";
import { detectPrUrl } from "../pr.js";
import type { SavedPrompt } from "../prompts/db.js";
import type { RunHandle } from "../runner/index.js";
import { PrChip } from "./chips.js";
import { CopyableText, hasContent, MessageView } from "./message-blocks.js";
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

// `active` tags the single server-rendered prompt card shown above
// #live-output so the live stream can remove it once it takes over prompt
// display — preventing a duplicate once the stream replays started prompts.
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

// A compact saved-prompt picker for the in-session follow-up bar. Selecting an
// item fills the follow-up textarea with template-substituted text (known
// placeholders only — unknowns stay literal for the user to edit). The
// working dir is exposed via a data attribute so the client can resolve
// {{working_dir}} without a round trip.
const FollowupPicker = ({
  prompts,
  workingDir,
}: {
  prompts: SavedPrompt[];
  workingDir: string;
}) => (
  <details class="followup-picker" data-working-dir={workingDir}>
    <summary class="followup-picker-btn" title="Insert a saved prompt">
      📋
    </summary>
    <div class="followup-picker-list">
      {prompts.length === 0 ? (
        <p class="followup-picker-empty">No saved prompts.</p>
      ) : (
        prompts.map((prompt) => (
          <button
            type="button"
            class="followup-picker-item"
            data-action="followup-use"
            data-prompt-body={prompt.body}
          >
            {prompt.title}
          </button>
        ))
      )}
    </div>
  </details>
);

const PromptBar = ({
  sessionId,
  run,
  prompts = [],
  workingDir = "",
}: {
  sessionId: string;
  run?: RunHandle;
  prompts?: SavedPrompt[];
  workingDir?: string;
}) => {
  const busy = isRunActive(run);
  const pendingCount = run?.pendingPrompts.length ?? 0;
  return (
    <form
      class="prompt-bar"
      data-prompt-bar
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
        <FollowupPicker prompts={prompts} workingDir={workingDir} />
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
  prompts = [],
}: {
  session: SessionRow;
  messages: ParsedMessage[];
  run?: RunHandle;
  prompt?: string;
  prompts?: SavedPrompt[];
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
      {/* #messages is always present so the live-tail stream can append to it
        even for sessions that start with no renderable messages. The empty
        placeholder is a sibling the client clears once content arrives. */}
      <div id="messages">
        {visible.map((entry) => (
          <MessageView message={entry.message} index={entry.index} />
        ))}
      </div>
      {isEmpty && (
        <p id="no-messages" class="empty">
          This session has no messages.
        </p>
      )}
      {prompt !== undefined && <SubmittedPrompt prompt={prompt} active />}
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
      <PromptBar
        sessionId={session.id}
        run={run}
        prompts={prompts}
        workingDir={session.working_dir}
      />
    </div>
  );
};

export { renderPromptCard, Transcript };
