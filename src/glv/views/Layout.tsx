import type { PropsWithChildren } from "hono/jsx";
import { HeadMeta } from "./head.js";

type LayoutProps = PropsWithChildren<{
  title: string;
  agentName: string;
}>;

// Runs synchronously in <head>, before first paint, so the saved theme (or
// the OS preference when nothing is stored) is applied instantly — no flash
// of the light theme on reload.
const themeBootstrap = `(function(){try{var t=localStorage.getItem('glv-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

const Layout = ({ title, agentName, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover"
      />
      <HeadMeta agentName={agentName} />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <script src="/assets/htmx.min.js" defer></script>
      <script src="/assets/stream.js" defer></script>
      <script src="/assets/agents.js" defer></script>
      <script src="/assets/rename.js" defer></script>
      <script src="/assets/actions.js" defer></script>
      <script src="/assets/ui.js" defer></script>
      <script src="/assets/prompts.js" defer></script>
      <script src="/assets/uploads.js" defer></script>
      <script src="/assets/location.js" defer></script>
      <script src="/assets/schedule.js" defer></script>
    </head>
    <body>{children}</body>
  </html>
);

export { Layout };
