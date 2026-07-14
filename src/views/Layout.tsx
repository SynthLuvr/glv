import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string }>;

const STYLES = `
body {
  font-family: system-ui, -apple-system, sans-serif;
  margin: 0;
  color: #1b1b1b;
  background: #fafafa;
}
main {
  max-width: 64rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
h1 {
  margin: 0 0 1.25rem;
  font-size: 1.4rem;
}
table {
  width: 100%;
  border-collapse: collapse;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
th,
td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid #ececec;
  vertical-align: top;
}
th {
  background: #f4f4f5;
  font-weight: 600;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
code {
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 0.85em;
}
.empty {
  padding: 2.5rem 1rem;
  color: #6b6b6b;
  text-align: center;
}
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

export type { LayoutProps };
export { Layout };
