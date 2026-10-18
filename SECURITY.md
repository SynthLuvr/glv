# Security Policy

glv is a self-hosted web app that renders coding-agent transcripts and
drives `goose` / `claude` processes. It authenticates a single owner
with passkeys, exposes a token-bearing JSON API, spawns agent
subprocesses, clones GitHub repositories through your `gh` CLI, and
accepts file uploads. This file explains what belongs in a security
report and how to send one.

## Supported versions

Only the latest release (and `main`) receives security fixes. glv is a
young project without long-term support branches, so update to the
latest version before reporting.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected security problem.
Report it through GitHub’s private vulnerability reporting for this
repository (**Security → Report a vulnerability**), or contact
[@SynthLuvr](https://github.com/SynthLuvr) directly if you prefer.

Include:

- what an attacker could do, and what access they need (an
  unauthenticated visitor, the authenticated owner, another local
  process, …);
- a reproduction: steps, requests, or — best of all — a failing
  description of where the check failed;
- the glv version (the release or `main` commit you are running) and
  your OS.

Reports are acknowledged within a week. Confirmed issues get a fix or a
stated plan, and credit in the release notes if you want it.

## Scope

**In scope**

- Bypassing passkey authentication, forging the session cookie, or
  escalating a JSON API token (`glv_at_…`) beyond what the API is
  documented to allow.
- Serving content from any route that today requires login without
  authenticating first.
- Breaking the sanitization of rendered agent output (a DOMPurify
  bypass) or injecting markup through the server-rendered views.
- Path traversal out of glv’s own data directories
  (`~/.local/share/glv/…` on Linux/macOS, `%APPDATA%\glv` on Windows) or
  the uploads area — reading or writing files the intended flows never
  touch.
- Making the viewer talk to unintended hosts or spend your credentials:
  SSRF through the GitHub repository source or the PR-status features,
  or misuse of the `gh` CLI glv shells out to.
- Corrupting or disclosing, through the web surface, the SQLite
  databases glv owns (auth, cron, prompts, groups, meta, suggestions,
  stop notices).

**Out of scope**

- Anything that already requires shell access on the machine or the
  privileges of the OS user running `glv serve`. The agents glv drives
  execute arbitrary commands **by design** — the viewer is their control
  plane, not a sandbox — so “a session can run code” is the product.
  Likewise, another process running as the same OS user can already read
  every database glv owns.
- Reaching glv over a LAN or the public internet without the
  TLS-terminating reverse proxy the README requires for non-localhost
  use. WebAuthn expects a secure context; exposing the port directly is
  a deployment mistake, not a glv bug.
- Vulnerabilities in the agents themselves (goose, claude) — report
  those to their upstream projects. A glv-side mitigation for an
  upstream issue is still welcome as a regular issue once the upstream
  report is public.
- Volume or denial-of-service reports with no novel vector. The server
  binds to localhost by default and is not built to be the first line of
  defense on a hostile network.

## Deployment notes

The first passkey registration permanently claims the app — on a shared
machine, start `glv serve` only when you are about to claim it. Behind a
reverse proxy, forward `Host` / `X-Forwarded-*` as the README describes,
so WebAuthn’s origin checks and the cookie flags stay correct.
