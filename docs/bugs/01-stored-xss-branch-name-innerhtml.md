# 01 — Stored XSS via malicious git branch name

- **Severity:** HIGH
- **Category:** Security / Stored XSS
- **Location:** src/scripts/source-picker.ts (lines 85-88)
- **Status:** Open

## Summary
Git branch names fetched live from the GitHub API are interpolated unescaped
into an HTML attribute via innerHTML, allowing script execution from a
crafted branch name.

## Buggy code

    datalist.innerHTML = (data.branches as string[])
      .map((b) => `<option value="${b}"></option>`)
      .join("");

## Why it fails
The branches come from /github/repos/{owner}/{repo}/branches, which proxies
the GitHub API. Git ref-naming rules forbid ~ ^ : ? * [ and a few others but
do NOT forbid the characters " < > or '. A branch such as:

    "><img src=x onerror=alert(document.domain)>

is a valid, pushable ref. When it lands in the map above the browser parses
the <img> as a real element inside the <datalist>, and onerror fires on the
failed src load -> arbitrary script execution.

## Impact
Runs inside Goose Log Viewer, which holds the user's gh credentials and can
spawn goose sessions (i.e. local code execution). Trigger: the victim opens
"New Session -> GitHub" on any repository that carries a maliciously named
branch. The sibling repo datalist (lines 56-64) uses the identical pattern
but is currently latent because GitHub constrains nameWithOwner to a safe
character class.

## Suggested fix
Do not build option HTML by string concatenation. Use the DOM API:

    const opt = document.createElement("option");
    opt.value = b;
    datalist.appendChild(opt);

Apply the same fix to the repo datalist for defense in depth.
