const PLACEHOLDER = /\{\{\s*([A-Za-z_]\w*)\s*\}\}/g;

const KNOWN_PLACEHOLDERS: readonly string[] = [
  "working_dir",
  "repo",
  "branch",
  "date",
];

type PlaceholderValues = Record<string, string>;

const isKnown = (name: string): boolean => KNOWN_PLACEHOLDERS.includes(name);

// Replaces every {{known}} placeholder whose name is present in `values`.
// Placeholders absent from `values` (including known-but-unset ones, e.g.
// {{repo}} when no repo is selected) are left untouched so the caller can
// decide whether to prompt the user.
const substitutePlaceholders = (
  body: string,
  values: PlaceholderValues,
): string =>
  body.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? "") : match,
  );

// Returns the distinct placeholder names that are neither known nor supplied
// in `values`, in order of first appearance — the set the UI must collect.
const findUnknownPlaceholders = (
  body: string,
  values: PlaceholderValues = {},
): string[] => {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name === undefined) continue;
    if (isKnown(name)) continue;
    if (Object.hasOwn(values, name)) continue;
    found.add(name);
  }
  return [...found];
};

// Today's date as YYYY-MM-DD in the user's local timezone, for {{date}}.
const today = (): string => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export {
  findUnknownPlaceholders,
  KNOWN_PLACEHOLDERS,
  substitutePlaceholders,
  today,
};
