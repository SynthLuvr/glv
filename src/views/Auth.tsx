import type { Child } from "hono/jsx";

// Mirrors the inline bootstrap in Layout.tsx so the saved theme applies before
// first paint on the auth screens (which use a standalone layout).
const themeBootstrap = `(function(){try{var t=localStorage.getItem('glv-theme');if(t==='dark'||(t===null&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark');}}catch(e){}})();`;

type AuthLayoutProps = {
  title: string;
  children: Child;
};

const AuthLayout = ({ title, children }: AuthLayoutProps) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      <title>{title}</title>
      <link rel="stylesheet" href="/app.css" />
      <script src="/passkey.js" defer></script>
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
