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

// A failed stylesheet request is neither retried nor re-fetched while its
// cache entry is fresh, so one transient transport error (tunnel flap,
// mobile network handover) leaves the page unstyled until a manual reload.
// On failure, refetch over a fresh connection and apply the result as a
// late <style> — a brief unstyled flash instead of a permanently unstyled
// page. The DOMContentLoaded probe catches failures that fired before the
// error listener attached.
const stylesheetRetryBootstrap = `(function(){var l=document.currentScript.previousElementSibling,delays=[0,2000,8000,20000,45000,90000],n=0,done=false;var attempt=function(){if(done||n>=delays.length)return;try{if(l.sheet&&l.sheet.cssRules.length>0)return}catch(e){}setTimeout(function(){if(done)return;fetch(l.href+"?retry="+Date.now()).then(function(r){return r.text()}).then(function(css){if(done)return;var s=document.createElement("style");s.textContent=css;s.setAttribute("data-appcss-retry","1");document.head.appendChild(s);done=true}).catch(attempt)},delays[n++])};l.addEventListener("error",attempt);document.addEventListener("DOMContentLoaded",attempt)})();`;

const Layout = ({ title, agentName, children }: LayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      {/* interactive-widget=resizes-content: the Android keyboard resizes
          the layout viewport (and dvh) instead of panning over this
          fixed-height shell — the default pan sticks when the focused
          textarea is swapped mid-submit, stranding the pane toggle. */}
      <meta
        name="viewport"
        content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
      />
      <HeadMeta agentName={agentName} />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      <title>{title}</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <script dangerouslySetInnerHTML={{ __html: stylesheetRetryBootstrap }} />
      <script src="/assets/htmx.min.js" defer></script>
      <script src="/assets/stream.js" defer></script>
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

export { Layout, stylesheetRetryBootstrap, themeBootstrap };
