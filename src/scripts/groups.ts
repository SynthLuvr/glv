type HtmxGroupsAjax = {
  // Touch note: native HTML5 drag-and-drop does not fire on touch devices.
  // The accessible "Move to group…" / "Remove from group" menu (rendered in
  // every session card) is the always-available touch fallback.  Drag is the
  // fast path on desktop; the menu is the universal path.
  ajax: (
    verb: string,
    path: string,
    options: {
      target: string;
      swap: string;
      values?: Record<string, string>;
    },
  ) => void;
};

const isHtmxGroupsAjax = (value: unknown): value is HtmxGroupsAjax =>
  typeof value === "object" &&
  value !== null &&
  "ajax" in value &&
  typeof value.ajax === "function";

const postGroupAction = (
  path: string,
  values: Record<string, string>,
): void => {
  const g = globalThis as { htmx?: unknown };
  const htmx = isHtmxGroupsAjax(g.htmx) ? g.htmx : undefined;
  if (htmx !== undefined)
    htmx.ajax("POST", path, {
      target: "#session-list",
      swap: "outerHTML",
      values,
    });
};

// ---- drag and drop ----

let dragSourceId: string | null = null;

const clearDragState = (): void => {
  document.querySelectorAll(".dragging, .drag-over").forEach((el) => {
    el.classList.remove("dragging", "drag-over");
  });
  dragSourceId = null;
};

document.addEventListener("dragstart", (e: DragEvent) => {
  const el = e.target instanceof Element ? e.target : null;
  const item = el?.closest(".session-item");
  if (item === null || item === undefined || e.dataTransfer === null) return;
  const id = item.getAttribute("data-session-id");
  if (id === null) return;
  dragSourceId = id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", id);
  item.classList.add("dragging");
});

document.addEventListener("dragend", clearDragState);

document.addEventListener("dragover", (e: DragEvent) => {
  if (dragSourceId === null) return;
  const el = e.target instanceof Element ? e.target : null;
  const groupHeader = el?.closest(".group-header") ?? null;
  const sessionItem = el?.closest(".session-item") ?? null;
  const listBg = el?.closest("#session-list") ?? null;
  if (groupHeader === null && sessionItem === null && listBg === null) return;
  e.preventDefault();
  if (e.dataTransfer !== null) e.dataTransfer.dropEffect = "move";

  // Highlight the immediate drop target (never the dragging source).
  document
    .querySelectorAll(".drag-over")
    .forEach((n) => n.classList.remove("drag-over"));
  if (groupHeader !== null) {
    groupHeader.classList.add("drag-over");
  } else if (
    sessionItem !== null &&
    !sessionItem.classList.contains("dragging")
  )
    sessionItem.classList.add("drag-over");
});

document.addEventListener("drop", (e: DragEvent) => {
  if (dragSourceId === null) return;
  e.preventDefault();
  const el = e.target instanceof Element ? e.target : null;
  const draggedId = dragSourceId;
  clearDragState();

  const groupHeader = el?.closest(".group-header") ?? null;
  const sessionItem = el?.closest(".session-item") ?? null;

  if (groupHeader !== null) {
    const groupId = groupHeader.getAttribute("data-group-id");
    if (groupId !== null)
      postGroupAction(`/sessions/${draggedId}/group`, { groupId });
  } else if (sessionItem !== null) {
    const targetId = sessionItem.getAttribute("data-session-id");
    if (targetId !== null && targetId !== draggedId)
      postGroupAction(`/sessions/${draggedId}/group-with`, {
        otherId: targetId,
      });
  } else if (el?.closest("#session-list") !== null)
    postGroupAction(`/sessions/${draggedId}/ungroup`, {});
});

// ---- collapse / expand ----

const COLLAPSED_KEY = "glv-collapsed-groups";

const loadCollapsed = (): Set<string> => {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (raw === null) return new Set();
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((s): s is string => typeof s === "string"));
  } catch {
    return new Set();
  }
};

const saveCollapsed = (ids: Set<string>): void => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage may be unavailable (private mode, quota); ignore.
  }
};

const collapsedGroups = loadCollapsed();

const applyCollapsedState = (): void => {
  document.querySelectorAll<HTMLElement>(".session-group").forEach((group) => {
    const id = group.getAttribute("data-group-id");
    if (id === null) return;
    const isCollapsed = collapsedGroups.has(id);
    group.classList.toggle("collapsed", isCollapsed);
    group
      .querySelector(".group-toggle")
      ?.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
  });
};

// ---- click delegation (toggle, menu close) ----

document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;

  // Close open group menus when clicking outside them.
  if (el !== null)
    document
      .querySelectorAll<HTMLDetailsElement>("details.session-group-menu[open]")
      .forEach((d) => {
        if (!d.contains(el)) {
          d.open = false;
          const slot = d.querySelector(".session-group-menu-slot");
          if (slot !== null) slot.innerHTML = "";
        }
      });

  // Group collapse / expand toggle.
  const toggleBtn = el?.closest("[data-action='toggle-group']");
  if (toggleBtn instanceof HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const group = toggleBtn.closest(".session-group");
    if (group === null) return;
    const groupId = group.getAttribute("data-group-id");
    if (groupId === null) return;
    if (collapsedGroups.has(groupId)) {
      collapsedGroups.delete(groupId);
      group.classList.remove("collapsed");
      toggleBtn.setAttribute("aria-expanded", "true");
    } else {
      collapsedGroups.add(groupId);
      group.classList.add("collapsed");
      toggleBtn.setAttribute("aria-expanded", "false");
    }
    saveCollapsed(collapsedGroups);
    return;
  }

  // Cancel button inside the group picker.
  const cancelBtn = el?.closest("[data-action='cancel-group-menu']");
  if (cancelBtn instanceof HTMLElement) {
    e.preventDefault();
    const details = cancelBtn.closest("details.session-group-menu");
    if (details instanceof HTMLDetailsElement) {
      details.open = false;
      const slot = details.querySelector(".session-group-menu-slot");
      if (slot !== null) slot.innerHTML = "";
    }
  }
});

// Re-apply collapsed state after htmx swaps the session list.
document.addEventListener("htmx:afterSwap", (e: Event) => {
  const target = e.target as Element | null;
  if (target !== null && target.id === "session-list") applyCollapsedState();
});

// Apply on initial load (script is deferred, so DOM is ready).
applyCollapsedState();
