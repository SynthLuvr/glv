const UPLOAD_ACCEPT =
  "image/*,application/pdf,text/*,.md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.sh,.sql";

// The hidden file input plus the chip/error containers the uploads script
// drives. Any form that embeds these and is tagged data-upload-form gains the
// full attach/paste flow (New Session form and the in-session prompt bar).
const UploadFields = () => (
  <>
    <input
      type="file"
      name="uploads"
      multiple
      class="upload-input-hidden"
      accept={UPLOAD_ACCEPT}
    />
    <p class="upload-error" style="display:none" />
    <div class="upload-chips" style="display:none" />
  </>
);

// The paperclip attach button. `compact` renders an icon-only square for the
// prompt-bar row; the full form shows the icon + label.
const PaperclipButton = ({ compact = false }: { compact?: boolean }) => (
  <button
    type="button"
    class={`paperclip-btn${compact ? " paperclip-btn--compact" : ""}`}
    aria-label="Attach files"
    title="Attach files"
  >
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
      <path d="M13.234 20.252 21 12.3" />
      <path d="M16 6a8.077 8.077 0 0 1-8 8 6 6 0 0 1-6-6 4 4 0 0 1 4-4 2.5 2.5 0 0 1 2.5 2.5 1.5 1.5 0 0 1-1.5 1.5" />
    </svg>
    {!compact && <span>Attach files</span>}
  </button>
);

export { PaperclipButton, UPLOAD_ACCEPT, UploadFields };
