import type { Child } from "hono/jsx";

// Mirrors the inline bootstrap in Layout.tsx so the saved theme applies before
// first paint on the auth screens (which use a standalone layout).
const themeBootstrap = `(function(){try{var t=localStorage.getItem('glv-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

// Inline SVG favicon (a feather quill) gives the tab an identity mark and
// stops the browser requesting /favicon.ico — a 404 on every page load.
const favicon =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%232563eb'/><g transform='translate(4 4)' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z'/><line x1='16' y1='8' x2='2' y2='22'/><line x1='17.5' y1='15' x2='9' y2='15'/></g></svg>";

type AuthLayoutProps = {
  title: string;
  children: Child;
};

const AuthLayout = ({ title, children }: AuthLayoutProps) => (
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
      <script src="/assets/passkey.js" defer></script>
    </head>
    <body>
      <main class="auth-main">{children}</main>
    </body>
  </html>
);

type AuthCardProps = {
  heading: string;
  sub: string;
  action: string;
  label: string;
  error?: string;
};

const AuthCard = ({ heading, sub, action, label, error }: AuthCardProps) => (
  <div class="auth-card">
    <div class="auth-shield">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    </div>
    <h1>{heading}</h1>
    <p class="auth-sub">{sub}</p>
    <button class="auth-btn" id="passkey-button" data-action={action}>
      {label}
    </button>
    <p class="auth-error" id="auth-error" hidden={true}></p>
    {error !== undefined && <p class="auth-banner-error">{error}</p>}
  </div>
);

const RegisterPage = () => (
  <AuthLayout title="Claim Goose Log Viewer">
    <AuthCard
      heading="Claim this app"
      sub="This viewer has no owner yet. Create a passkey to become its permanent owner — no email, no password. Anyone can claim it first."
      action="register"
      label="Create passkey"
    />
  </AuthLayout>
);

const LoginPage = ({ error }: { error?: string }) => (
  <AuthLayout title="Log in — Goose Log Viewer">
    <AuthCard
      heading="Welcome back"
      sub="Log in with your passkey to continue."
      action="login"
      label="Log in with passkey"
      error={error}
    />
  </AuthLayout>
);

export { LoginPage, RegisterPage };
