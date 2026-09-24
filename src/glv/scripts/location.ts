import { htmxSwapTarget } from "./htmx.js";
import { sessionOfBar } from "./shared.js";

// "Share my location" flow for any form carrying LocationFields (the New
// Session form and the in-session prompt bar). The browser Geolocation API
// resolves the device's position on click; the share is staged in the
// form's hidden `location` field as JSON the server validates and appends
// to the prompt — the same shape as an upload, minus the file.

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 30000,
};

// What is staged between click and submit; also what re-renders the chip
// when the prompt bar survives a busy/idle swap.
type StagedLocation = {
  latitude: number;
  longitude: number;
  accuracy?: number;
};

const pinIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg>';
const removeIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

let staged: StagedLocation | undefined;

// A busy/idle prompt-bar swap replaces the form node while the user may be
// composing a follow-up; the staged share must survive it (uploads.ts
// carries its chips the same way).
let carrySessionId: string | undefined;

const showError = (container: HTMLElement | null, message: string): void => {
  if (container === null) return;
  container.textContent = message;
  container.style.display = "block";
  window.setTimeout(() => {
    if (container.textContent === message) container.style.display = "none";
  }, 5000);
};

const geoErrorMessage = (err: GeolocationPositionError): string => {
  if (err.code === err.PERMISSION_DENIED)
    return "Location permission was denied — allow access in your browser settings and try again.";
  if (err.code === err.TIMEOUT)
    return "Getting your location took too long — try again.";
  return "Your location could not be determined right now.";
};

// Five decimals is ~1 m on the ground — finer than phone GPS and short
// enough for the chip.
const fmtCoord = (value: number): string => value.toFixed(5);

const fmtSummary = (loc: StagedLocation): string => {
  const coords = `${fmtCoord(loc.latitude)}, ${fmtCoord(loc.longitude)}`;
  if (loc.accuracy === undefined) return coords;
  return `${coords} · ±${Math.round(loc.accuracy)} m`;
};

const coordsOf = (coords: GeolocationCoordinates): StagedLocation => {
  const loc: StagedLocation = {
    latitude: coords.latitude,
    longitude: coords.longitude,
  };
  if (Number.isFinite(coords.accuracy) && coords.accuracy >= 0)
    loc.accuracy = coords.accuracy;
  return loc;
};

const createChip = (loc: StagedLocation, onRemove: () => void): HTMLElement => {
  const chip = document.createElement("div");
  chip.className = "location-chip";

  const thumb = document.createElement("span");
  thumb.className = "chip-thumb chip-thumb-icon";
  thumb.innerHTML = pinIcon;
  chip.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "chip-info";

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = "Current location";
  info.appendChild(name);

  const detail = document.createElement("span");
  detail.className = "chip-size";
  detail.textContent = fmtSummary(loc);
  info.appendChild(detail);

  chip.appendChild(info);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chip-remove";
  remove.setAttribute("aria-label", "Remove shared location");
  remove.innerHTML = removeIcon;
  remove.addEventListener("click", () => {
    onRemove();
  });
  chip.appendChild(remove);

  return chip;
};

const renderChip = (container: HTMLElement, input: HTMLInputElement): void => {
  container.innerHTML = "";
  if (staged !== undefined)
    container.appendChild(
      createChip(staged, () => {
        staged = undefined;
        input.value = "";
        renderChip(container, input);
      }),
    );
  container.style.display = staged !== undefined ? "flex" : "none";
};

const stage = (
  coords: GeolocationCoordinates,
  container: HTMLElement | null,
  input: HTMLInputElement,
): void => {
  staged = coordsOf(coords);
  input.value = JSON.stringify(staged);
  if (container !== null) renderChip(container, input);
};

const setLocating = (button: HTMLButtonElement, on: boolean): void => {
  if (on) {
    button.classList.add("is-locating");
    button.setAttribute("aria-busy", "true");
  } else {
    button.classList.remove("is-locating");
    button.removeAttribute("aria-busy");
  }
};

const wireForm = (form: HTMLFormElement): void => {
  const input = form.querySelector<HTMLInputElement>('input[name="location"]');
  const button = form.querySelector<HTMLButtonElement>(".location-btn");
  const chipsContainer = form.querySelector<HTMLElement>(".location-chips");
  const errorEl = form.querySelector<HTMLElement>(".upload-error");

  if (input === null || button === null) return;

  // A fresh form node starts empty — unless it is the same session's
  // prompt bar re-rendered by a busy/idle swap, which inherits the staged
  // share captured by the beforeSwap listener below.
  const sessionId = sessionOfBar(form);
  const inheritStaged = sessionId !== undefined && sessionId === carrySessionId;
  carrySessionId = undefined;
  if (inheritStaged && staged !== undefined) {
    input.value = JSON.stringify(staged);
    if (chipsContainer !== null) renderChip(chipsContainer, input);
  } else {
    staged = undefined;
    input.value = "";
    if (chipsContainer !== null) renderChip(chipsContainer, input);
  }

  button.addEventListener("click", () => {
    if (button.classList.contains("is-locating")) return;
    if (!("geolocation" in navigator)) {
      showError(errorEl, "Location sharing is not supported by this browser.");
      return;
    }
    setLocating(button, true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(button, false);
        stage(position.coords, chipsContainer, input);
      },
      (err) => {
        setLocating(button, false);
        showError(errorEl, geoErrorMessage(err));
      },
      GEO_OPTIONS,
    );
  });
};

// Identity-keyed: a form that survives a swap isn't re-wired, but a freshly
// swapped node (new identity) is.
const wired = new WeakSet<HTMLFormElement>();

const initLocationForms = (): void => {
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "[data-upload-form]",
  )) {
    if (wired.has(form)) continue;
    wired.add(form);
    wireForm(form);
  }
};

document.addEventListener("DOMContentLoaded", initLocationForms);

// Capture which session's prompt bar is about to be swapped so the fresh
// node can inherit the staged share (see wireForm).
document.body.addEventListener("htmx:beforeSwap", (e) => {
  const target = htmxSwapTarget(e);
  if (target?.hasAttribute("data-prompt-bar"))
    carrySessionId = sessionOfBar(target);
});

// A detail-pane swap (navigation/submit) or a prompt-bar swap (busy/idle
// transition) both bring a fresh form node to wire.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = htmxSwapTarget(e);
  if (target?.id === "detail-pane") {
    carrySessionId = undefined;
    initLocationForms();
    return;
  }
  if (target?.hasAttribute("data-prompt-bar")) initLocationForms();
});
