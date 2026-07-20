const tryParseJson = (stdout: string): unknown => {
  // `gh`/`git` may exit 0 with non-JSON stdout (an update notice or help text);
  // degrade to `null` rather than throw on a SyntaxError.
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

export { tryParseJson };
