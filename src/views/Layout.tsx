import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string }>;

const STYLES = `
:root {
  --bg: #f7f7f8;
  --surface: #ffffff;
  --surface-2: #f9fafb;
  --border: #e5e7eb;
  --border-strong: #d1d5db;
  --text: #1f2328;
  --text-muted: #6b7280;
  --text-faint: #9ca3af;
  --accent: #2563eb;
  --accent-soft: #eff6ff;
  --prompt-bg: #eef4ff;
  --prompt-border: #dbe7ff;
  --code-bg: #0d1117;
  --code-text: #e6edf3;
  --inline-bg: #eef0f3;
  --ok: #059669;
  --warn: #b45309;
  --err: #dc2626;
  --err-soft: #fef2f2;
  --err-border: #fecaca;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--text);
  background: var(--bg);
  font-size: 15px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* ---------- layout ---------- */
.app { display: flex; height: 100vh; overflow: hidden; }
.sidebar {
  width: 19rem;
  min-width: 16rem;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 1.1rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  position: sticky;
  top: 0;
  z-index: 2;
}
.sidebar-head h1 { margin: 0; font-size: 1rem; font-weight: 650; }
.session-count {
  font-size: 0.72rem;
  color: var(--text-muted);
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0.02rem 0.45rem;
  border-radius: 999px;
}
.empty { padding: 2.5rem 1rem; color: var(--text-faint); text-align: center; }

/* ---------- session cards ---------- */
.session-list { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.4rem; }
.session-item {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0.45rem;
  padding: 0.55rem 0.7rem;
  border-radius: 0.6rem;
  border: 1px solid transparent;
  cursor: pointer;
}
.session-item:hover { background: var(--surface-2); }
.session-check {
  flex-shrink: 0;
  margin: 0.2rem 0 0;
  cursor: pointer;
  accent-color: var(--accent);
}
.session-link {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
  flex: 1;
  min-width: 0;
  text-decoration: none;
  color: var(--text);
}
.session-item.selected {
  background: var(--accent-soft);
  border-color: #cfe0ff;
}
.session-item.selected .session-name { color: var(--accent); }
.session-item.htmx-request { opacity: 0.5; }
.session-name {
  font-weight: 600;
  font-size: 0.88rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-sub {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.72rem;
  color: var(--text-muted);
}
.session-sub time { white-space: nowrap; }
.provider-badge {
  background: var(--surface-2);
  border: 1px solid var(--border);
  padding: 0 0.35rem;
  border-radius: 999px;
  font-size: 0.66rem;
  color: var(--text-muted);
}
.token-count { color: var(--text-faint); }
.session-dir {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.68rem;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- bulk selection ---------- */
.bulk-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  margin: 0.2rem 0.35rem 0.35rem;
  background: var(--accent-soft);
  border: 1px solid #cfe0ff;
  border-radius: 0.5rem;
  font-size: 0.76rem;
  color: var(--text-muted);
}
.bulk-bar[hidden] { display: none; }
.bulk-count-wrap { margin-right: auto; }
.bulk-count-wrap strong { color: var(--accent); }
.bulk-archive-btn {
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  padding: 0.22rem 0.6rem;
  border-radius: 0.4rem;
  font-size: 0.74rem;
  font-weight: 600;
  cursor: pointer;
}
.bulk-archive-btn:hover { background: var(--surface-2); }

/* ---------- detail pane ---------- */
.detail { flex: 1; overflow-y: auto; }
.detail-inner { max-width: 50rem; margin: 0 auto; padding: 2.25rem 2.5rem 4rem; }
.placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  text-align: center;
  color: var(--text-faint);
}
.placeholder h2 { margin: 0; font-size: 1.1rem; font-weight: 600; color: var(--text-muted); }
.placeholder p { margin: 0; }
.placeholder code {
  font-family: ui-monospace, monospace;
  background: var(--inline-bg);
  padding: 0.1em 0.35em;
  border-radius: 0.3em;
}

/* ---------- session header ---------- */
.session-header {
  position: relative;
  margin-bottom: 1.75rem;
  padding-bottom: 1.25rem;
  border-bottom: 1px solid var(--border);
}
.archive-btn {
  position: absolute;
  top: -0.15rem;
  right: 0;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-muted);
  padding: 0.28rem 0.75rem;
  border-radius: 0.45rem;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.archive-btn:hover {
  color: var(--err);
  border-color: var(--err);
  background: var(--err-soft);
}
.session-header h2 { margin: 0 0 0.75rem; font-size: 1.25rem; font-weight: 650; }
.session-meta { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0; }
.meta-chip {
  display: inline-flex;
  flex-direction: column;
  gap: 0.04rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.28rem 0.6rem;
  min-width: 0;
}
.meta-label {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  color: var(--text-faint);
}
.meta-value { font-size: 0.8rem; word-break: break-all; }
.meta-value.mono { font-family: ui-monospace, monospace; font-size: 0.78rem; }

/* ---------- messages ---------- */
.message { margin-bottom: 1.4rem; }
.message.tool { margin-bottom: 0.85rem; }
.message-head {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.4rem;
}
.tag { font-weight: 700; font-size: 0.72rem; letter-spacing: 0.03em; }
.tag.prompt { color: var(--accent); }
.tag.output { color: var(--ok); }
.tag.tool { color: var(--text-muted); }
.message-head time { margin-left: auto; font-size: 0.72rem; color: var(--text-faint); }
.message-body { display: flex; flex-direction: column; gap: 0.5rem; }
.message-text {
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.6;
}
/* prompts read like a chat bubble; outputs render as flowing prose */
.message.prompt .message-text {
  background: var(--prompt-bg);
  border: 1px solid var(--prompt-border);
  border-radius: 0.75rem;
  padding: 0.8rem 1.05rem;
}

/* ---------- markdown ---------- */
.markdown { line-height: 1.65; word-wrap: break-word; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 {
  margin: 1.3em 0 0.55em;
  line-height: 1.3;
  font-weight: 650;
}
.markdown h1 { font-size: 1.4em; }
.markdown h2 { font-size: 1.22em; padding-bottom: 0.25em; border-bottom: 1px solid var(--border); }
.markdown h3 { font-size: 1.08em; }
.markdown h4 { font-size: 1em; }
.markdown p { margin: 0.6em 0; }
.markdown ul, .markdown ol { margin: 0.6em 0; padding-left: 1.5em; }
.markdown li { margin: 0.2em 0; }
.markdown li > ul, .markdown li > ol { margin: 0.2em 0; }
.markdown blockquote {
  margin: 0.8em 0;
  padding: 0.1em 1em;
  border-left: 3px solid var(--border-strong);
  color: var(--text-muted);
}
.markdown a { color: var(--accent); text-decoration: none; }
.markdown a:hover { text-decoration: underline; }
.markdown hr { border: none; border-top: 1px solid var(--border); margin: 1.4em 0; }
.markdown strong { font-weight: 650; }
.markdown del { color: var(--text-muted); }
.markdown img { max-width: 100%; border-radius: 0.4rem; }
.markdown table {
  border-collapse: collapse;
  margin: 0.8em 0;
  display: block;
  overflow-x: auto;
}
.markdown th, .markdown td {
  border: 1px solid var(--border);
  padding: 0.4em 0.7em;
  text-align: left;
}
.markdown th { background: var(--surface-2); font-weight: 600; }
.markdown :not(pre) > code {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  background: var(--inline-bg);
  padding: 0.12em 0.38em;
  border-radius: 0.35em;
  font-size: 0.87em;
}

/* ---------- code blocks (dark) ---------- */
pre {
  background: var(--code-bg);
  color: var(--code-text);
  margin: 0.8em 0;
  padding: 0.9rem 1rem;
  border-radius: 0.6rem;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 0.82em;
  line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: inherit; }

/* ---------- collapsible blocks (thinking / tool calls / results) ---------- */
.block {
  border: 1px solid var(--border);
  border-radius: 0.6rem;
  background: var(--surface-2);
  overflow: hidden;
}
.block > summary {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  font-size: 0.82rem;
  user-select: none;
  list-style: none;
}
.block > summary::-webkit-details-marker { display: none; }
.block > summary::before {
  content: "▸";
  flex-shrink: 0;
  color: var(--text-faint);
  font-size: 0.7rem;
  transition: transform 0.12s ease;
}
.block[open] > summary::before { transform: rotate(90deg); }
.block > summary:hover { background: var(--surface); }
.block-icon { font-size: 0.85rem; flex-shrink: 0; }
.block-label { font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.tool-name {
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: var(--text);
  font-size: 0.8rem;
  flex-shrink: 0;
}
.tool-ext {
  flex-shrink: 0;
  font-size: 0.66rem;
  color: var(--text-faint);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 0 0.3rem;
  border-radius: 999px;
}
.block-preview {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: 0.74rem;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.block-content {
  border-top: 1px solid var(--border);
  padding: 0.75rem 1rem;
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.6;
}
.block > pre { margin: 0; border-radius: 0; max-height: 26rem; overflow: auto; }

.thinking { background: #faf8f1; border-color: #efe6cf; }
.thinking > summary:hover { background: #fdfaf0; }
.thinking .block-label { color: var(--warn); }
.thinking .block-content { color: var(--text-muted); font-style: italic; font-size: 0.85rem; }

.tool-result.is-error { background: var(--err-soft); border-color: var(--err-border); }
.tool-result.is-error > summary:hover { background: #fdebeb; }
.tool-result.is-error .block-label { color: var(--err); }

/* ---------- scrollbars ---------- */
.sidebar::-webkit-scrollbar,
.detail::-webkit-scrollbar,
pre::-webkit-scrollbar { width: 9px; height: 9px; }
.sidebar::-webkit-scrollbar-thumb,
.detail::-webkit-scrollbar-thumb,
pre::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 999px; }
.sidebar::-webkit-scrollbar-thumb:hover,
.detail::-webkit-scrollbar-thumb:hover { background: #b8bcc4; }

/* ---------- responsive ---------- */
@media (max-width: 720px) {
  .app { flex-direction: column; }
  .sidebar { width: 100%; min-width: 0; max-height: 38vh; }
  .detail-inner { padding: 1.5rem 1.25rem 3rem; }
}
`;

const Layout = ({ title, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{STYLES}</style>
      <script src="/htmx.min.js" defer></script>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
