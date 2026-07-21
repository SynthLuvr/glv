type HtmxGroupsAjax = {
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
  const { htmx } = globalThis as { htmx?: unknown };
  if (!isHtmxGroupsAjax(htmx)) return;
  htmx.ajax("POST", path, {
    target: "#session-list",
    swap: "outerHTML",
    values,
  });
};

// ---- drag and drop ----
// Native HTML5 drag-and-drop is desktop-only; the per-card group menu is the
// always-available touch fallback.

let dragSourceId: string | null = null;

const clearDragState = (): void => {
  document.querySelectorAll(".dragging, .drag-over").forEach((el) => {
    el.classList.remove("dragging", "drag-over");
  });
  dragSourceId = null;
};

document.addEventListener("dragstart", (e) => {
  if (e.dataTransfer === null) return;
  const el = e.target instanceof Element ? e.target : null;
  const item = el?.closest(".session-item") ?? null;
  if (item === null) return;
  const id = item.getAttribute("data-session-id");
  if (id === null) return;
  dragSourceId = id;
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", id);
  item.classList.add("dragging");
});

document.addEventListener("dragend", clearDragState);

document.addEventListener("dragover", (e) => {
  if (dragSourceId === null || e.dataTransfer === null) return;
  const el = e.target instanceof Element ? e.target : null;
  const groupHeader = el?.closest(".group-header") ?? null;
  const sessionItem = el?.closest(".session-item") ?? null;
  const inList = el?.closest("#session-list") !== null;
  if (groupHeader === null && sessionItem === null && !inList) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";

  document
    .querySelectorAll(".drag-over")
    .forEach((n) => n.classList.remove("drag-over"));
  // Never highlight the item being dragged.
  if (groupHeader !== null) groupHeader.classList.add("drag-over");
  else if (sessionItem !== null && !sessionItem.classList.contains("dragging"))
    sessionItem.classList.add("drag-over");
});

document.addEventListener("drop", (e) => {
  if (dragSourceId === null) return;
  e.preventDefault();
  const draggedId = dragSourceId;
  clearDragState();

  const el = e.target instanceof Element ? e.target : null;
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

const parseCollapsed = (raw: string | null): Set<string> => {
  if (raw === null) return new Set();
  const arr: unknown = JSON.parse(raw);
  return Array.isArray(arr)
    ? new Set(arr.filter((s): s is string => typeof s === "string"))
    : new Set();
};

const loadCollapsed = (): Set<string> => {
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY));
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
    const collapsed = collapsedGroups.has(id);
    group.classList.toggle("collapsed", collapsed);
    group
      .querySelector(".group-toggle")
      ?.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
};

// ---- group menu ----

const closeMenu = (details: HTMLDetailsElement): void => {
  details.open = false;
  const slot = details.querySelector(".session-group-menu-slot");
  if (slot !== null) slot.innerHTML = "";
};

const closeMenusOutside = (click: Element): void => {
  document
    .querySelectorAll<HTMLDetailsElement>("details.session-group-menu[open]")
    .forEach((d) => {
      if (!d.contains(click)) closeMenu(d);
    });
};

const toggleCollapsed = (group: Element, groupId: string): void => {
  const collapse = !collapsedGroups.has(groupId);
  if (collapse) collapsedGroups.add(groupId);
  else collapsedGroups.delete(groupId);
  group.classList.toggle("collapsed", collapse);
  group
    .querySelector("[data-action='toggle-group']")
    ?.setAttribute("aria-expanded", collapse ? "true" : "false");
  saveCollapsed(collapsedGroups);
};

// Document-level delegation survives the out-of-band sidebar swaps that
// grouping triggers, mirroring sidebar.ts.
document.addEventListener("click", (e) => {
  const el = e.target instanceof Element ? e.target : null;
  if (el !== null) closeMenusOutside(el);

  const toggleBtn = el?.closest("[data-action='toggle-group']");
  if (toggleBtn instanceof HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const group = toggleBtn.closest(".session-group");
    if (group === null) return;
    const groupId = group.getAttribute("data-group-id");
    if (groupId === null) return;
    toggleCollapsed(group, groupId);
    return;
  }

  const cancelBtn = el?.closest("[data-action='cancel-group-menu']");
  if (cancelBtn instanceof HTMLElement) {
    e.preventDefault();
    const details = cancelBtn.closest("details.session-group-menu");
    if (details instanceof HTMLDetailsElement) closeMenu(details);
  }
});

// Re-apply collapsed state after htmx swaps the session list.
document.addEventListener("htmx:afterSwap", (e) => {
  const target = e.target as Element | null;
  if (target !== null && target.id === "session-list") applyCollapsedState();
});

// Script is deferred, so the DOM is ready.
applyCollapsedState();
