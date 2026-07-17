# 08 — Auth verify routes throw on malformed JSON

- **Severity:** MEDIUM
- **Category:** Error-handling gap / unhandled exception
- **Location:** src/server/routes/auth.tsx (lines 49-57, 63-69)
- **Status:** Open

## Summary

The WebAuthn verify endpoints call c.req.json() without a try/catch. A
non-JSON body throws and bubbles to Hono’s default handler as an HTTP
500.

## Buggy code

    app.post("/auth/register/verify", async (c) => {
      ...
      const result = await auth.verifyRegistration(
        rpFromContext(c, ctx),
        await c.req.json(),          // throws on non-JSON body
      );
      return finishAuth(c, result, "Verification failed.");
    });

## Why it fails

c.req.json() runs JSON.parse internally and rejects on invalid input.
Neither verify route nor the options routes (43-61) guard against this
or against auth-service exceptions, so any auth-service throw also
becomes an opaque 500 instead of a structured 400.

## Impact

A trivially craftable malformed POST degrades these public endpoints
with an unhelpful 500; uncaught exceptions also surface as 500s
elsewhere.

## Suggested fix

Wrap body parsing and the auth-service call in try/catch and return a
clean 400 with { verified: false, error } on failure, mirroring the
structured shape finishAuth already uses.
