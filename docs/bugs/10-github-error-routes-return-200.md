# 10 — GitHub error routes return HTTP 200

- **Severity:** LOW
- **Category:** Wrong HTTP status / error-handling gap
- **Location:** src/server/routes/github.tsx (lines 23-29, 31-40)
- **Status:** Open

## Summary
The repo and branch listing routes return failure as a 200 with an ok:false
body, violating HTTP semantics.

## Buggy code

    app.get("/github/repos", async (c) => {
      try {
        return c.json({ ok: true, repos: await ctx.gh.listRepos() });
      } catch (err) {
        return c.json({ ok: false, error: errorMessage(err) }); // HTTP 200
      }
    });

## Why it fails
The catch branch omits a status code, so Hono defaults to 200. gh not
installed, not authenticated, or a network error all look like success to
any HTTP-level monitor, proxy, or cache.

## Impact
Misleading status codes; the client JS already inspects ok so functionality
is unaffected, but observability and retry logic are.

## Suggested fix
Return an appropriate 4xx/5xx, e.g. c.json({ ok: false, error }, 502).
