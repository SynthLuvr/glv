import { type } from "arktype";
import { parseJson } from "../parse.js";

// Wire shape of the client's location share: the Geolocation API's
// latitude/longitude plus the accuracy radius in metres, serialized into
// the form's hidden `location` field as JSON.
const SharedLocationSchema = type({
  latitude: "number",
  longitude: "number",
  "accuracy?": "number",
});

type SharedLocation = typeof SharedLocationSchema.infer;

// Reading the form field yields one of three outcomes: nothing was shared,
// a valid share, or a malformed share the route must reject so the user
// can retry instead of the agent receiving garbage coordinates.
type ParsedLocation =
  | { readonly ok: true; readonly value: SharedLocation }
  | { readonly ok: false; readonly error: string };

const LOCATION_READ_ERROR =
  "That location could not be read — remove the chip and share again.";

// JSON.parse already rejects NaN/Infinity spellings, but a valid literal
// like 1e999 still yields Infinity, so finiteness is re-checked here.
const inRange = (value: number, min: number, max: number): boolean =>
  Number.isFinite(value) && value >= min && value <= max;

const parseSharedLocation = (raw: string): ParsedLocation | undefined => {
  if (raw === "") return undefined;
  const parsed = parseJson(raw, SharedLocationSchema);
  if (!parsed.ok) return { ok: false, error: LOCATION_READ_ERROR };
  const { latitude, longitude } = parsed.data;
  if (!inRange(latitude, -90, 90) || !inRange(longitude, -180, 180))
    return { ok: false, error: LOCATION_READ_ERROR };
  return { ok: true, value: parsed.data };
};

// Five decimals is ~1 m of ground distance — far finer than phone GPS, and
// short enough to keep the prompt tidy.
const fmtCoord = (value: number): string => value.toFixed(5);

// Appends a location section to the prompt so the agent sees where the
// user is, mirroring how uploads append their file paths: plain text the
// agent can reason over, plus a map link it can fetch when helpful.
const buildLocationContext = (loc: SharedLocation): string => {
  const lat = fmtCoord(loc.latitude);
  const lon = fmtCoord(loc.longitude);
  const accuracy =
    loc.accuracy !== undefined &&
    Number.isFinite(loc.accuracy) &&
    loc.accuracy >= 0
      ? ` (±${Math.round(loc.accuracy)} m accuracy)`
      : "";
  const map = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
  return `\n\n---\nUser's current location, shared from their device${accuracy}:\n- Coordinates: ${lat}, ${lon}\n- Map: ${map}`;
};

export type { SharedLocation };
export { buildLocationContext, parseSharedLocation };
