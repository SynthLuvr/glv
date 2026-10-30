import type { PropsWithChildren } from "hono/jsx";
import { favicon } from "./head.js";
import { themeBootstrap } from "./Layout.js";

// The /pitch page: a self-contained, public (no-auth) single-page tour of
// glv. It shares the compiled stylesheet and design tokens with the app
// (see styles/pitch.css, imported by app.css) but not the app shell — no
// htmx, no session scripts, just the theme bootstrap so it follows the
// same dark/light preference as the viewer.

const REPO = "https://github.com/SynthLuvr/glv";

const Nav = () => (
  <nav class="pitch-nav">
    <div class="pitch-container pitch-nav-inner">
      <a href="/pitch" class="pitch-brand" title="Guided Live Velocity">
        glv
      </a>
      <div class="pitch-nav-links">
        <a href="#features">Features</a>
        <a href="#api">API</a>
        <a href="#oss">Open source</a>
      </div>
      <a href="/" class="pitch-btn pitch-btn-primary pitch-btn-sm">
        Open the viewer
      </a>
    </div>
  </nav>
);

const Terminal = ({ lines }: { lines: string[] }) => (
  <figure class="pitch-terminal" aria-label="terminal">
    <div class="pitch-terminal-bar" aria-hidden="true">
      <span class="dot dot-r" />
      <span class="dot dot-y" />
      <span class="dot dot-g" />
    </div>
    <pre>
      <code>
        {lines.map((line) => (
          <span class="pitch-terminal-line" key={line}>
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  </figure>
);

const Hero = ({ agentNames }: { agentNames: string }) => (
  <header class="pitch-hero">
    <div class="pitch-container">
      <h1>The self-hosted mission control for coding agents.</h1>
      <p class="pitch-hero-sub">
        Launch {agentNames} sessions from a form, watch the output stream live,
        schedule the busywork, and keep every transcript searchable — all on
        your own machine, behind your own passkey. No cloud. No accounts. Fork
        the whole thing.
      </p>
      <div class="pitch-hero-actions">
        <a href="/" class="pitch-btn pitch-btn-primary">
          Open the viewer
        </a>
        <a href={REPO} class="pitch-btn pitch-btn-ghost">
          Fork on GitHub
        </a>
      </div>
      <Terminal
        lines={[
          "$ git clone https://github.com/SynthLuvr/glv.git && cd glv",
          "$ node scripts/setup.mjs",
          "$ glv serve",
          "▲ glv → http://localhost:3000",
        ]}
      />
    </div>
  </header>
);

const Stat = ({ value, label }: { value: string; label: string }) => (
  <div class="pitch-stat">
    <div class="pitch-stat-value">{value}</div>
    <div class="pitch-stat-label">{label}</div>
  </div>
);

const Stats = ({ agentNames }: { agentNames: string }) => (
  <section class="pitch-stats" aria-label="glv in numbers">
    <div class="pitch-container pitch-stats-grid">
      <Stat value={agentNames} label="one sidebar, one schedule" />
      <Stat value="1" label="Node process serves everything" />
      <Stat value="0" label="Electron windows" />
      <Stat value="6" label="concurrent runs by default" />
      <Stat value="1" label="passkey owns the whole app" />
      <Stat value="0" label="accounts, emails, telemetry" />
    </div>
  </section>
);

const Card = ({
  title,
  id,
  children,
}: PropsWithChildren<{ title: string; id?: string }>) => (
  <article class="pitch-card" id={id}>
    <h3>{title}</h3>
    {children}
  </article>
);

const CardList = ({ items }: { items: string[] }) => (
  <ul class="pitch-card-list">
    {items.map((item) => (
      <li key={item}>{item}</li>
    ))}
  </ul>
);

const ApiCode = () => (
  <pre class="pitch-code">
    <code>{`TOKEN=$(glv token create --name loop)
ID=$(curl -sS -X POST http://localhost:3000/api/sessions \\
  -H "Authorization: Bearer $TOKEN" \\
  -F prompt="address issue #57" \\
  -F working_dir="$PWD" | jq -r .id)

# park until it settles — one connection, no poll loop
curl -sS -H "Authorization: Bearer $TOKEN" \\
  "http://localhost:3000/api/sessions/$ID/wait?timeout=-1"`}</code>
  </pre>
);

const Features = () => (
  <section id="features" class="pitch-section">
    <div class="pitch-container">
      <h2>Why glv</h2>
      <div class="pitch-cards">
        <Card title="Your agents already took the notes.">
          <p>
            goose writes every prompt, tool call, and reasoning step into
            SQLite; Claude Code writes transcripts to disk. glv opens both
            read-only and renders them as a clean, searchable transcript.
            Nothing to import, nothing to sync — sessions you started in a
            terminal show up on their own.
          </p>
        </Card>
        <Card title="Watch them work.">
          <p>
            Point a run at a directory on disk or a GitHub repo (cloned with
            your existing <code>gh</code> auth) and the output streams the
            moment the agent writes it. Queue follow-ups mid-run — they chain
            automatically — and when a provider cuts a run short, the session
            says why, reset time included.
          </p>
        </Card>
        <Card title="The busywork has a calendar now.">
          <p>
            Type <code>every weekday at 9:00</code> or <code>0 9 * * 1-5</code>{" "}
            — validated live, with the upcoming runs previewed before you save.
            IANA timezones, per-job model pins, and a missed occurrence fires
            exactly once on the next start. Never a burst, never twice.
          </p>
        </Card>
        <Card title="Built to be driven by other agents." id="api">
          <p>
            The UI and the JSON API run the same operation layer — everything
            you can click, a script can do. The OpenAPI contract is generated
            from the same schemas the routes validate with, so it cannot drift.
          </p>
          <ApiCode />
        </Card>
        <Card title="Runs that clean up after themselves.">
          <p>
            Every run spawns in its own process group, and the whole tree is
            reaped when the run settles — an agent's stray MCP servers can't
            outlive it. Under systemd each run gets a transient scope with a
            memory ceiling: a runaway is killed inside its own box while the
            server and sibling sessions carry on.
          </p>
        </Card>
        <Card title="Private by design.">
          <p>
            The first person to open the viewer creates a passkey and
            permanently owns the app — that is the entire account system. No
            emails, no passwords, no telemetry. Your data is a handful of SQLite
            files under <code>~/.local/share/glv</code>. It's your machine; glv
            just lives there.
          </p>
        </Card>
      </div>
    </div>
  </section>
);

const OpenSource = ({ agentNames }: { agentNames: string }) => (
  <section id="oss" class="pitch-section pitch-oss">
    <div class="pitch-container">
      <h2>If you don't like something, it's a pull request.</h2>
      <p class="pitch-section-sub">
        glv is Apache-2.0 and distributed as source — cloning the repo is the
        install. There is no SPA to learn: server-rendered hono/jsx, progressive
        enhancement with htmx, one Tailwind v4 stylesheet.
      </p>
      <div class="pitch-cards">
        <Card title="Change the UI">
          <CardList
            items={[
              "Server-rendered pages, no framework ritual.",
              "Product code lives once; lint fails any duplicate.",
              "One shared design-token palette, dark and light.",
            ]}
          />
        </Card>
        <Card title="Add an agent">
          <CardList
            items={[
              "The adapter surface is small on purpose.",
              "Invocation, storage, launch — and nothing else.",
              `Ships today: ${agentNames}.`,
            ]}
          />
        </Card>
        <Card title="Run it anywhere">
          <CardList
            items={[
              "One Node process on Linux, macOS, or Windows.",
              "In a terminal anyway? glv sessions · glv view · glv logs.",
              "Docs live in the README, not a docs site.",
            ]}
          />
        </Card>
      </div>
    </div>
  </section>
);

const FinalCta = () => (
  <section class="pitch-section pitch-final">
    <div class="pitch-container">
      <h2>Your agents deserve better than a terminal tab.</h2>
      <p class="pitch-section-sub">
        glv is free, open source, and one Node process. Clone it, run{" "}
        <code>glv serve</code>, and close those tabs.
      </p>
      <div class="pitch-hero-actions">
        <a href="/" class="pitch-btn pitch-btn-primary">
          Open the viewer
        </a>
        <a href={REPO} class="pitch-btn pitch-btn-ghost">
          Read the source
        </a>
      </div>
    </div>
  </section>
);

const Footer = ({ agentNames }: { agentNames: string }) => (
  <footer class="pitch-footer">
    <div class="pitch-container pitch-footer-inner">
      <span>Apache-2.0</span>
      <span aria-hidden="true">·</span>
      <span>self-hosted</span>
      <span aria-hidden="true">·</span>
      <span>{agentNames}</span>
      <span aria-hidden="true">·</span>
      <a href={REPO}>source on GitHub</a>
    </div>
  </footer>
);

const PitchPage = ({ agentNames }: { agentNames: string }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href={favicon} />
      <meta name="color-scheme" content="light dark" />
      <meta
        name="description"
        content={`glv — drive ${agentNames} from one fast, self-hosted browser UI. Stream runs live, schedule the busywork, and keep every transcript searchable.`}
      />
      <title>glv — the self-hosted mission control for coding agents</title>
      <link rel="stylesheet" href="/assets/app.css" />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
    </head>
    <body class="pitch-body">
      <Nav />
      <main>
        <Hero agentNames={agentNames} />
        <Stats agentNames={agentNames} />
        <Features />
        <OpenSource agentNames={agentNames} />
        <FinalCta />
      </main>
      <Footer agentNames={agentNames} />
    </body>
  </html>
);

export { PitchPage };
