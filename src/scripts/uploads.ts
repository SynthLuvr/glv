const UPLOADS_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB — mirrors server limit

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isImage = (file: File): boolean => file.type.startsWith("image/");

const removeIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
const fileIcon =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/></svg>';

let selectedFiles: File[] = [];
let pastedImageCount = 0;

const imageExtByType: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const imageExtForType = (type: string): string => imageExtByType[type] ?? "png";

// One oversized file rejects the whole batch.
const addFiles = (
  incoming: File[],
  input: HTMLInputElement,
  chipsContainer: HTMLElement | null,
  errorEl: HTMLElement | null,
): void => {
  for (const file of incoming)
    if (file.size > UPLOADS_MAX_FILE_SIZE) {
      if (errorEl !== null)
        showError(
          errorEl,
          `"${file.name}" is ${formatFileSize(file.size)} — the limit is ${formatFileSize(UPLOADS_MAX_FILE_SIZE)}.`,
        );
      return;
    }

  selectedFiles = [...selectedFiles, ...incoming];
  if (chipsContainer !== null) renderChips(chipsContainer, input);
  syncInput(input);
};

const syncInput = (input: HTMLInputElement): void => {
  const dt = new DataTransfer();
  for (const file of selectedFiles) dt.items.add(file);
  input.files = dt.files;
};

const createThumbnail = (file: File): HTMLElement => {
  if (isImage(file)) {
    const img = document.createElement("img");
    img.className = "chip-thumb";
    img.alt = "";
    img.src = URL.createObjectURL(file);
    return img;
  }
  const wrap = document.createElement("span");
  wrap.className = "chip-thumb chip-thumb-icon";
  wrap.innerHTML = fileIcon;
  return wrap;
};

const createChip = (
  file: File,
  index: number,
  onRemove: (index: number) => void,
): HTMLElement => {
  const chip = document.createElement("div");
  chip.className = "upload-chip";

  const thumb = createThumbnail(file);
  chip.appendChild(thumb);

  const info = document.createElement("div");
  info.className = "chip-info";

  const name = document.createElement("span");
  name.className = "chip-name";
  name.textContent = file.name;
  name.title = file.name;
  info.appendChild(name);

  const size = document.createElement("span");
  size.className = "chip-size";
  size.textContent = formatFileSize(file.size);
  info.appendChild(size);

  chip.appendChild(info);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "chip-remove";
  remove.setAttribute("aria-label", `Remove ${file.name}`);
  remove.innerHTML = removeIcon;
  remove.addEventListener("click", () => {
    onRemove(index);
  });
  chip.appendChild(remove);

  return chip;
};

const renderChips = (container: HTMLElement, input: HTMLInputElement): void => {
  container.innerHTML = "";
  selectedFiles.forEach((file, index) => {
    container.appendChild(
      createChip(file, index, (i) => {
        selectedFiles.splice(i, 1);
        renderChips(container, input);
        syncInput(input);
      }),
    );
  });
  container.style.display = selectedFiles.length > 0 ? "flex" : "none";
};

const showError = (container: HTMLElement, message: string): void => {
  container.textContent = message;
  container.style.display = "block";
  window.setTimeout(() => {
    if (container.textContent === message) container.style.display = "none";
  }, 5000);
};

const collectPastedImages = (dt: DataTransfer): File[] => {
  const images: File[] = [];
  for (const item of dt.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null || !file.type.startsWith("image/")) continue;
    pastedImageCount += 1;
    const ext = imageExtForType(file.type);
    images.push(
      new File([file], `pasted-image-${pastedImageCount}.${ext}`, {
        type: file.type,
      }),
    );
  }
  return images;
};

// Wires a single form's attach/paste flow. Reset the shared file state so a
// freshly arrived form (e.g. after a prompt-bar swap) starts empty.
const wireForm = (form: HTMLFormElement): void => {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const button = form.querySelector<HTMLButtonElement>(".paperclip-btn");
  const chipsContainer = form.querySelector<HTMLElement>(".upload-chips");
  const errorEl = form.querySelector<HTMLElement>(".upload-error");

  if (input === null || button === null) return;

  selectedFiles = [];
  pastedImageCount = 0;

  button.addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    if (input.files === null) return;
    const incoming = Array.from(input.files);
    input.value = "";
    addFiles(incoming, input, chipsContainer, errorEl);
  });

  // Only image items are intercepted; plain-text paste still reaches the
  // prompt textarea.
  form.addEventListener("paste", (e: ClipboardEvent) => {
    if (e.clipboardData === null) return;
    const images = collectPastedImages(e.clipboardData);
    if (images.length === 0) return;
    e.preventDefault();
    addFiles(images, input, chipsContainer, errorEl);
  });

  const hintEl = form.querySelector<HTMLElement>(".paste-hint");
  if (hintEl !== null) {
    const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
    hintEl.textContent = `Tip: paste images with ${isMac ? "⌘" : "Ctrl"}+V`;
  }

  // Ensure the hidden file input carries the selected files into the htmx
  // multipart submission even if htmx re-reads the form at submit time.
  form.addEventListener("submit", () => syncInput(input));
};

// Tracks already-wired forms so re-init after a swap is a no-op for a form
// that is still in place, while a freshly swapped form (new DOM node) wires
// up and resets the file state. Only one upload form is on a page at a time
// (the New Session form or the in-session prompt bar).
const wired = new WeakSet<HTMLFormElement>();

const initUploadForms = (): void => {
  for (const form of document.querySelectorAll<HTMLFormElement>(
    "[data-upload-form]",
  )) {
    if (wired.has(form)) continue;
    wired.add(form);
    wireForm(form);
  }
};

document.addEventListener("DOMContentLoaded", initUploadForms);

// Re-init when the whole detail pane swaps (navigation, prompt submit) and
// when just the prompt bar swaps on a busy/idle transition — both bring a
// fresh form node that needs wiring.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (
    target?.id === "detail-pane" ||
    target?.hasAttribute("data-prompt-bar") === true
  )
    initUploadForms();
});
