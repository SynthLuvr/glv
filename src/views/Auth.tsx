import type { Child } from "#jsx";
import type { CredentialSummary } from "../auth/db.js";
import { HeadMeta } from "./head.js";

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
      <HeadMeta />
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
  token?: string;
};

const AuthCard = ({
  heading,
  sub,
  action,
  label,
  error,
  token,
}: AuthCardProps) => {
  // data-token is only present on the enroll screen; the client reads it to
  // scope the options/verify calls to /auth/enroll/:token.
  const extra = token === undefined ? {} : { "data-token": token };
  return (
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
      <button
        class="auth-btn"
        id="passkey-button"
        data-action={action}
        {...extra}
      >
        {label}
      </button>
      <p class="auth-error" id="auth-error" hidden={true}></p>
      {error !== undefined && <p class="auth-banner-error">{error}</p>}
    </div>
  );
};

const RegisterPage = () => (
  <AuthLayout title="Claim — GLV">
    <AuthCard
      heading="Claim this app"
      sub="This viewer has no owner yet. Create a passkey to become its permanent owner — no email, no password. Anyone can claim it first."
      action="register"
      label="Create passkey"
    />
  </AuthLayout>
);

const LoginPage = ({ error }: { error?: string }) => (
  <AuthLayout title="Log in — GLV">
    <AuthCard
      heading="Welcome back"
      sub="Log in with your passkey to continue."
      action="login"
      label="Log in with passkey"
      error={error}
    />
  </AuthLayout>
);

// Reached via an enrollment link on a new origin: the ceremony creates a fresh
// passkey bound to this origin's RP ID and attaches it to the existing owner.
const EnrollPage = ({ token }: { token: string }) => (
  <AuthLayout title="Add passkey — GLV">
    <AuthCard
      heading="Add a passkey"
      sub="Create a passkey for this device or domain. It links to your existing account so the same owner can sign in from here too."
      action="enroll"
      label="Create passkey"
      token={token}
    />
  </AuthLayout>
);

type DevicesPageProps = {
  credentials: CredentialSummary[];
  enrollUrl?: string;
  token?: string;
};

// Owner-only management screen. A passkey is locked to the domain it was made
// on, so to sign in from both localhost and another origin the owner needs one
// passkey per origin — added here via a single-use enrollment link.
const DevicesPage = ({ credentials, enrollUrl, token }: DevicesPageProps) => (
  <AuthLayout title="Passkeys — GLV">
    <div class="auth-card">
      <h1>Passkeys</h1>
      <p class="auth-sub">
        A passkey is locked to the domain it was created on, so one made on{" "}
        <code>localhost</code> can't unlock another domain (or vice versa). Add
        a passkey for each place you sign in.
      </p>
      {credentials.length === 0 ? (
        <p class="auth-sub">No passkeys yet.</p>
      ) : (
        <ul class="cred-list">
          {credentials.map((c) => (
            <li>
              <code class="cred-id">{c.id.slice(0, 12)}</code>
              <span class="cred-date">{c.createdAt}</span>
            </li>
          ))}
        </ul>
      )}
      <form method="post" action="/auth/devices">
        <button class="auth-btn" type="submit">
          Add a passkey for another device or domain
        </button>
      </form>
      {enrollUrl !== undefined && token !== undefined && (
        <div class="enroll-link">
          {/* Machine-readable token for tests/automation; the visible URL is
              the copy-paste link for the current origin. */}
          <data id="enroll-token" value={token} />
          <p class="auth-sub">
            Open this on the device/domain you want to enroll — for another
            domain, swap the host:
          </p>
          <code class="enroll-url">{enrollUrl}</code>
        </div>
      )}
    </div>
  </AuthLayout>
);

export { DevicesPage, EnrollPage, LoginPage, RegisterPage };
