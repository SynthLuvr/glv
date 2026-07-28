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

const initUploadForm = (): void => {
  const form = document.querySelector<HTMLFormElement>("form.new-session-form");
  if (form === null) return;

  const input = form.querySelector<HTMLInputElement>('input[type="file"]');
  const button = form.querySelector<HTMLButtonElement>(".paperclip-btn");
  const chipsContainer = form.querySelector<HTMLElement>(".upload-chips");
  const errorEl = form.querySelector<HTMLElement>(".upload-error");

  if (input === null || button === null) return;

  selectedFiles = [];

  button.addEventListener("click", () => input.click());

  input.addEventListener("change", () => {
    if (input.files === null) return;
    const incoming = Array.from(input.files);
    input.value = "";

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
  });

  // Ensure the hidden file input carries the selected files into the htmx
  // multipart submission even if htmx re-reads the form at submit time.
  form.addEventListener("submit", () => syncInput(input));
};

document.addEventListener("DOMContentLoaded", initUploadForm);

// htmx swaps #detail-pane innerHTML; re-init when the form arrives.
document.body.addEventListener("htmx:afterSwap", (e) => {
  const target = (e as Event & { detail?: { target?: HTMLElement | null } })
    .detail?.target;
  if (target?.id === "detail-pane") initUploadForm();
});
