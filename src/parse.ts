const tryParseJson = <T = unknown>(stdout: string): T | null => {
  // `gh`/`git` may exit 0 with non-JSON stdout (an update notice or help text);
  // degrade to `null` rather than throw on a SyntaxError.
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
};

export { tryParseJson };
