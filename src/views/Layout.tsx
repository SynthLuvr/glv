import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string }>;

const STYLES = `
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font-family: system-ui, -apple-system, sans-serif;
  color: #1b1b1b;
  background: #fafafa;
}

.app { display: flex; height: 100vh; overflow: hidden; }

.sidebar {
  width: 24rem;
  min-width: 20rem;
  flex-shrink: 0;
  border-right: 1px solid #e4e4e7;
  background: #fff;
  overflow-y: auto;
}
.sidebar-head {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #ececec;
  background: #fff;
  position: sticky;
  top: 0;
  z-index: 1;
}
.sidebar-head h1 { margin: 0; font-size: 1.05rem; }
.empty { padding: 2.5rem 1rem; color: #6b6b6b; text-align: center; }

table { width: 100%; border-collapse: collapse; }
th,
td {
  text-align: left;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid #ececec;
  vertical-align: top;
  font-size: 0.82rem;
}
th {
  background: #f4f4f5;
  font-weight: 600;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
tr.selected { background: #eef4ff; }
td a { color: #2563eb; text-decoration: none; font-weight: 500; }
td a:hover { text-decoration: underline; }
code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.85em; }

.detail { flex: 1; overflow-y: auto; padding: 2rem 2.5rem; }
.detail-inner { max-width: 52rem; margin: 0 auto; }
.placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #9b9b9b;
  text-align: center;
}
.placeholder h2 { font-size: 1.1rem; font-weight: 600; margin: 0 0 0.25rem; }
.placeholder p { margin: 0; }

.session-header {
  margin-bottom: 1.75rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #ececec;
}
.session-header h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
.session-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.5rem;
  margin: 0;
  font-size: 0.8rem;
  color: #6b6b6b;
}
.session-meta dt { font-weight: 600; color: #4b4b4b; }
.session-meta dd { margin: 0; }

.message { margin-bottom: 1.5rem; }
.message-head {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  margin-bottom: 0.3rem;
}
.tag { font-weight: 700; font-size: 0.78rem; letter-spacing: 0.02em; }
.prompt .tag { color: #2563eb; }
.output .tag { color: #059669; }
.message-head time { font-size: 0.74rem; color: #9b9b9b; }
.message-body {
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.6;
  padding: 0.85rem 1rem;
  border-radius: 0.5rem;
}
.prompt .message-body { background: #eff4ff; }
.output .message-body { background: #f0faf4; }
`;

const Layout = ({ title, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{STYLES}</style>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
