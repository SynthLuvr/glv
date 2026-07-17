# 09 — WebAuthn single shared challenge slot

- **Severity:** MEDIUM
- **Category:** Race condition / availability (weak DoS) / security best practice
- **Location:** src/auth/service.ts (lines 78-88, store/consume at 105/113 and 158/166)
- **Status:** Open

## Summary
Registration and login share one in-memory challenge variable with no TTL.
Any second options request clobbers it, and the endpoints are unauthenticated.

## Buggy code

    let currentChallenge: string | undefined;
    const storeChallenge = (challenge) => { currentChallenge = challenge; };
    const takeChallenge = () => {
      const challenge = currentChallenge;
      currentChallenge = undefined;
      return challenge;
    };

## Why it fails
A second browser tab, a retry, a page that refetches options, or any
unauthenticated attacker hitting /auth/register/options or
/auth/login/options overwrites the value, so the legitimate verify returns
"No registration/login in progress." The stored challenge also never expires,
departing from WebAuthn best practice (challenges should live only minutes).

## Impact
Intermittent registration/login failures and a cheap unauthenticated lockout
against the owner's in-flight flow.

## Suggested fix
Use a per-flow, time-boxed challenge (e.g. a short-lived map keyed by a
per-ceremony nonce, or a signed challenge token) with an explicit expiry.
