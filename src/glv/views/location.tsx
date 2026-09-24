const MapPinIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);

// Fields backing the "share my location" action: the hidden `location`
// input carrying the share payload and the chip surface the client script
// renders into. Errors reuse the upload form's .upload-error element so the
// two attachment flows read as one UI.
const LocationFields = () => (
  <>
    <input type="hidden" name="location" class="location-input-hidden" />
    <div class="location-chips" style="display:none" />
  </>
);

const LocationButton = ({ compact = false }: { compact?: boolean }) => (
  <button
    type="button"
    class={`location-btn${compact ? " location-btn--compact" : ""}`}
    aria-label="Share current location"
    title="Share current location"
  >
    <MapPinIcon />
    {!compact && <span>Location</span>}
  </button>
);

export { LocationButton, LocationFields };
