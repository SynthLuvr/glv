import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string }>;

// Runs synchronously in <head>, before first paint, so the saved theme (or
// the OS preference when nothing is stored) is applied instantly — no flash
// of the light theme on reload.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('glv-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

// Inline SVG favicon (a feather quill) gives the tab an identity mark and
// stops the browser requesting /favicon.ico — a 404 on every page load.
const favicon =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%232563eb'/><g transform='translate(4 4)' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z'/><line x1='16' y1='8' x2='2' y2='22'/><line x1='17.5' y1='15' x2='9' y2='15'/></g></svg>";

const Layout = ({ title, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href={favicon} />
      <meta name="color-scheme" content="light dark" />
      <meta
        name="theme-color"
        content="#f7f7f8"
        media="(prefers-color-scheme: light)"
      />
      <meta
        name="theme-color"
        content="#0d1117"
        media="(prefers-color-scheme: dark)"
      />
      <meta
        name="description"
        content="Browse goose session history, stream live runs, and launch new goose runs from your browser."
      />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <script src="/assets/htmx.min.js" defer></script>
      <script src="/assets/stream.js" defer></script>
      <script src="/assets/theme.js" defer></script>
      <script src="/assets/markdown-copy.js" defer></script>
      <script src="/assets/rename.js" defer></script>
      <script src="/assets/source-picker.js" defer></script>
      <script src="/assets/ui.js" defer></script>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
