const tryParseJson = (stdout: string): unknown => {
  // `gh`/`git` may exit 0 with non-JSON stdout (an update notice, a warning, or
  // unauthenticated help text); degrade to `null` instead of throwing on a
  // SyntaxError — callers translate the sentinel into their own fallback.
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

export { tryParseJson };
