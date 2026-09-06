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

// A busy/idle prompt-bar swap replaces the form node while the user may be
// composing a follow-up; the staged chips must survive it. The bar's session
// id is captured just before the swap and matched against the fresh node in
// wireForm, so files never leak into another session's or the New Session
// form.
let carrySessionId: string | undefined;

const sessionOfBar = (bar: Element): string | undefined => {
  const match = /^\/sessions\/([^/]+)\/prompt$/.exec(
    bar.getAttribute("hx-post") ?? "",
  );
  return match === null ? undefined : match[1];
};

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

const filesEqual = (a: FileList | null, b: File[]): boolean => {
  if (a === null) return b.length === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const syncInput = (input: HTMLInputElement): void => {
  // Preserve the native selection when it matches: File objects rebuilt via
  // DataTransfer lose their OS backing (Android content:// URIs, iOS picks)
  // and fail to serialize in the htmx multipart body, breaking the submit on
  // mobile. Rebuild only when the tracked set differs — e.g. a removed chip.
  if (filesEqual(input.files, selectedFiles)) return;
  try {
    const dt = new DataTransfer();
    for (const file of selectedFiles) dt.items.add(file);
    input.files = dt.files;
  } catch {
    // DataTransfer unavailable on iOS Safari — keep the native selection.
  }
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

// Module-level chip state persists across swaps; reset so a fresh form
// starts empty.
const wireForm = (form: HTMLFormElement): void => {
  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const button = form.querySelector<HTMLButtonElement>(".paperclip-btn");
  const chipsContainer = form.querySelector<HTMLElement>(".upload-chips");
  const errorEl = form.querySelector<HTMLElement>(".upload-error");

  if (input === null || button === null) return;

  // A fresh form node starts empty — unless it is the same session's prompt
  // bar re-rendered by a busy/idle swap, which inherits the staged chips
  // (captured by the beforeSwap listener below).
  const sessionId = sessionOfBar(form);
  const inheritStaged =
    sessionId !== undefined &&
    sessionId === carrySessionId &&
    selectedFiles.length > 0;
  carrySessionId = undefined;
  if (inheritStaged && chipsContainer !== null) {
    renderChips(chipsContainer, input);
    syncInput(input);
  } else {
    selectedFiles = [];
    pastedImageCount = 0;
  }

  // Reset on click, not in the change handler: clearing after the OS fills
  // the input discards the native File objects, which can't be rebuilt on
  // mobile (see syncInput). This also lets the same file be picked twice.
  button.addEventListener("click", () => {
    input.value = "";
    input.click();
  });

  input.addEventListener("change", () => {
    if (input.files === null) return;
    const incoming = Array.from(input.files);
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

// Identity-keyed: a form that survives a swap isn't re-wired, but a freshly
// swapped node (new identity) is.
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

// Capture which session's prompt bar is about to be swapped so the fresh
// node can inherit the staged chips (see wireForm).
document.body.addEventListener("htmx:beforeSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target?.hasAttribute("data-prompt-bar"))
    carrySessionId = sessionOfBar(target);
});

// A detail-pane swap (navigation/submit) or a prompt-bar swap (busy/idle
// transition) both bring a fresh form node to wire.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target?.id === "detail-pane") {
    // Navigation replaced the whole pane; a captured carry must not leak
    // into whatever form the new pane brings.
    carrySessionId = undefined;
    initUploadForms();
    return;
  }
  if (target?.hasAttribute("data-prompt-bar")) initUploadForms();
});

export {};
