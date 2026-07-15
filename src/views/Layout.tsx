import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string }>;

const Layout = ({ title, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <link rel="stylesheet" href="/app.css" />
      <script src="/htmx.min.js" defer></script>
      <script src="/stream.js" defer></script>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
