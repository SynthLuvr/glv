const normalize = (value: string): string =>
  value.toLowerCase().replace(/[_/]/g, " ").replace(/\s+/g, " ").trim();

// A zone's current UTC offset, minutes east of Greenwich (negative
// west). Computed through the same Intl plumbing the schedule parser
// trusts; bare "GMT" (no offset suffix) means zero.
const zoneOffsetMinutes = (zone: string): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date());
  const name = parts.find((part) => part.type === "timeZoneName")?.value;
  const match =
    name === undefined ? null : /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (match === null) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
};

// Offset queries: "utc+2", "gmt-05:00", "+9", "utc" (offset zero).
// A bare sign or a utc/gmt prefix is required — plain digits are more
// likely a zone fragment ("Kolkata" hasn't been finished) than an
// offset wish.
const OFFSET_QUERY_RE =
  /^(?:(?:utc|gmt)\s*)?([+-])\s*(\d{1,2})(?::?(\d{2}))?$|^(?:utc|gmt)$/;

const parseOffsetQuery = (query: string): number | undefined => {
  const match = OFFSET_QUERY_RE.exec(query);
  if (match === null) return undefined;
  if (match[0] === "utc" || match[0] === "gmt") return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  return sign * (hours * 60 + minutes);
};

// "UTC+05:30" / "UTC-04:00" — the label spelling shown beside every
// suggestion so an offset query can confirm itself.
const offsetLabel = (minutes: number): string => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const mins = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${mins}`;
};

// Canonical zones for the empty field (server-local first) and for
// ranking offset matches — every inhabited offset's best-known zone.
const POPULAR_ZONES: readonly string[] = [
  "Etc/UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
];

// The abbreviations people type from habit, resolved to a canonical
// zone (the suggestion's offset label disambiguates DST). Looked up
// after the same normalization as zone names — case and spaces don't
// matter.
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  utc: "Etc/UTC",
  gmt: "Etc/GMT",
  est: "America/New_York",
  edt: "America/New_York",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  mst: "America/Denver",
  mdt: "America/Denver",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  cet: "Europe/Paris",
  cest: "Europe/Berlin",
  bst: "Europe/London",
  ist: "Asia/Kolkata",
  jst: "Asia/Tokyo",
  kst: "Asia/Seoul",
  hkt: "Asia/Hong_Kong",
  sgt: "Asia/Singapore",
  aest: "Australia/Sydney",
  acst: "Australia/Adelaide",
  awst: "Australia/Perth",
  nzst: "Pacific/Auckland",
};

// The runtime's candidate list. Canonical aliases (Etc/UTC and friends)
// are absent from supportedValuesOf but valid for Intl and croner, so
// they join the set explicitly.
const ALL_ZONES: readonly string[] = Array.from(
  new Set([
    ...Intl.supportedValuesOf("timeZone"),
    ...Object.values(ABBREVIATIONS),
  ]),
);

const POPULAR_RANK = new Map(POPULAR_ZONES.map((zone, i) => [zone, i]));

// Popular zones lead within a ranking tier; every other zone shares the
// rank just past the list.
const popularRank = (zone: string): number =>
  POPULAR_RANK.get(zone) ?? POPULAR_ZONES.length;

// The server process's own IANA zone — what an empty timezone field
// means (the field's placeholder names it) and what the starter list
// leads with.
const SERVER_TIMEZONE: string =
  Intl.DateTimeFormat().resolvedOptions().timeZone;

type TimezoneSuggestion = {
  /** The IANA name the combobox commits. */
  readonly zone: string;
  /** Current UTC offset, minutes east — for the suggestion label. */
  readonly offsetMinutes: number;
  /** Marks the server's own zone in the starter list. */
  readonly server?: boolean;
};

const suggestion = (zone: string, server = false): TimezoneSuggestion => ({
  zone,
  offsetMinutes: zoneOffsetMinutes(zone),
  ...(server ? { server: true } : {}),
});

// The starter list shown on an empty field: the server's zone named as
// itself, then the canonical world tour.
const starterSuggestions = (
  serverTimezone: string,
): readonly TimezoneSuggestion[] => [
  suggestion(serverTimezone, true),
  ...POPULAR_ZONES.filter((zone) => zone !== serverTimezone).map((zone) =>
    suggestion(zone),
  ),
];

// The suggestion cap, so the popup stays a pick list.
const MAX_SUGGESTIONS = 12;

// Timezone search for the schedule form's combobox. The candidates are
// the runtime's own IANA list — exactly the names parseSchedule accepts.
// Matches come back best-first: an abbreviation's canonical zone ("est"),
// then the city segment as a prefix ("new york"), then a substring
// anywhere in the name, then zones sitting on the queried UTC offset
// ("utc+2") — popular zones lead within a tier, then alphabetical.
const searchTimezones = (query: string): readonly TimezoneSuggestion[] => {
  const normalized = normalize(query);
  if (normalized === "") return [];
  const spaceless = normalized.replace(/ /g, "");
  const abbreviated = ABBREVIATIONS[spaceless];
  const offset = parseOffsetQuery(normalized);

  type Scored = { readonly zone: string; readonly score: number };
  const scored: Scored[] = [];
  const seen = new Set<string>();
  const add = (zone: string, score: number): void => {
    if (seen.has(zone)) return;
    seen.add(zone);
    scored.push({ zone, score });
  };

  if (abbreviated !== undefined) add(abbreviated, 0);
  for (const zone of ALL_ZONES) {
    const name = normalize(zone);
    const city = name.slice(name.lastIndexOf(" ") + 1);
    if (city === normalized) add(zone, 1);
    else if (city.startsWith(normalized)) add(zone, 2);
    else if (name.includes(normalized)) add(zone, 3);
    else if (offset !== undefined && zoneOffsetMinutes(zone) === offset)
      add(zone, 4);
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (popularRank(a.zone) !== popularRank(b.zone))
        return popularRank(a.zone) - popularRank(b.zone);
      return a.zone.localeCompare(b.zone);
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((match) => suggestion(match.zone));
};

export type { TimezoneSuggestion };
export { offsetLabel, SERVER_TIMEZONE, searchTimezones, starterSuggestions };
