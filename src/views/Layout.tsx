import type { PropsWithChildren } from "hono/jsx";

type LayoutProps = PropsWithChildren<{ title: string; assetVersion: string }>;

// Runs synchronously in <head>, before first paint, so the saved theme (or
// the OS preference when nothing is stored) is applied instantly — no flash
// of the light theme on reload.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('glv-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

const assetSrc = (path: string, version: string): string =>
  `${path}?v=${version}`;

const Layout = ({ title, assetVersion, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      <title>{title}</title>
      <link rel="stylesheet" href={assetSrc("/assets/app.css", assetVersion)} />
      <script
        src={assetSrc("/assets/htmx.min.js", assetVersion)}
        defer
      ></script>
      <script src={assetSrc("/assets/stream.js", assetVersion)} defer></script>
      <script src={assetSrc("/assets/theme.js", assetVersion)} defer></script>
      <script
        src={assetSrc("/assets/markdown-copy.js", assetVersion)}
        defer
      ></script>
      <script src={assetSrc("/assets/rename.js", assetVersion)} defer></script>
      <script
        src={assetSrc("/assets/source-picker.js", assetVersion)}
        defer
      ></script>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
