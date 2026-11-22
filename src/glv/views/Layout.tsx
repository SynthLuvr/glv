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

/*
  Heals a page whose app.css request failed against the tunnel relay.

  #409 retried on the link's error event but gave up after 165s; the
  tunnel's journal shows outage windows far longer than that (the
  2026-11-11 flap ran ~20 minutes, restart counter 24, and a silently
  dead path is only noticed after ~90s by the ssh keepalive) — so the
  ladder always lost to the outages it was built for. This watchdog
  never gives up: it polls until the sentinel custom property from
  app.css is actually applied, retrying over a fresh cache-busted
  connection with capped backoff (worst case one small GET every 10s)
  for as long as the document stays unstyled. A 200 without the
  sentinel (empty body, portal page) is ignored rather than latched on.

  It sits BEFORE the stylesheet link on purpose: an inline script that
  follows a pending stylesheet never executes, so a hung (never-erroring)
  connection would leave a script-after-link inert — while timer
  callbacks are not blocked by stylesheets, so this one keeps ticking.

  Healthy loads do nothing: the first tick sees the sentinel and stops,
  with zero extra requests.
*/
const stylesheetWatchdog = `(function(){
  var SENTINEL = "--glv-css";
  var link = null, timer = 0, delay = 500, failed = false, applied = null;
  var seenAt = 0, attempts = 0;
  var styled = function(){
    try {
      return getComputedStyle(document.documentElement)
        .getPropertyValue(SENTINEL).trim() === "loaded";
    } catch (e) { return false; }
  };
  var heal = function(){
    fetch(link.href + "?retry=" + Date.now(), { cache: "reload" })
      .then(function(r){ return r.text(); })
      .then(function(css){
        if (css.indexOf(SENTINEL) < 0) {
          console.warn("app.css watchdog: response carried no sentinel, ignoring ("
            + (++attempts) + " attempts)");
          return;
        }
        if (!applied) {
          applied = document.createElement("style");
          applied.id = "app-css-healed";
          document.head.appendChild(applied);
        }
        applied.textContent = css;
        applied.dataset.attempts = String(attempts);
      })
      .catch(function(e){
        console.warn("app.css watchdog: attempt " + (++attempts)
          + " failed — retrying; error:", e);
      });
  };
  var tick = function(){
    if (styled()) return;
    if (!link) {
      link = document.getElementById("app-css");
      if (!link) { timer = setTimeout(tick, 100); return; }
      seenAt = Date.now();
      link.addEventListener("error", function(){
        failed = true;
        if (!styled()) tick();
      });
    }
    var pending = !failed && !link.sheet;
    var inGrace = Date.now() - seenAt < 3000;
    if (!pending || !inGrace) heal();
    delay = Math.min(delay * 2, 10000);
    timer = setTimeout(tick, delay);
  };
  timer = setTimeout(tick, 500);
  document.addEventListener("visibilitychange", function(){
    // The reported shape: returning to the page after minutes away — tick
    // now instead of waiting out the current backoff step.
    if (!document.hidden && !styled()) { clearTimeout(timer); tick(); }
  });
})();`;

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
      <script dangerouslySetInnerHTML={{ __html: stylesheetWatchdog }} />
      <link rel="stylesheet" id="app-css" href="/assets/app.css" />
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

export { Layout, stylesheetWatchdog, themeBootstrap };
