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

// ---- drag to group (pointer events: mouse + touch) ----
// Native HTML5 drag-and-drop never fires on touch devices, so a unified
// pointer-event drag layer drives grouping on every input type.  A dedicated
// drag handle keeps vertical list scrolling usable on touch: the handle
// carries `touch-action: none`, so a gesture that starts on it belongs to the
// drag and never scrolls the page.

const DRAG_THRESHOLD_PX = 6;

type ActiveDrag = {
  sourceId: string;
  sourceEl: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLElement | null;
};

let activeDrag: ActiveDrag | null = null;

const clearDragClasses = (): void => {
  document.querySelectorAll(".dragging, .drag-over").forEach((el) => {
    el.classList.remove("dragging", "drag-over");
  });
};

const cleanupDrag = (): void => {
  if (activeDrag === null) return;
  activeDrag.ghost?.remove();
  clearDragClasses();
  activeDrag = null;
};

// A floating clone of the source card follows the pointer so the dragged
// session stays visible under a finger — on touch the finger covers the card
// itself.
const createGhost = (source: HTMLElement): HTMLElement => {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.classList.remove("dragging");
  ghost.classList.add("drag-ghost");
  const rect = source.getBoundingClientRect();
  ghost.style.width = `${rect.width}px`;
  return ghost;
};

const positionGhost = (
  ghost: HTMLElement | null,
  x: number,
  y: number,
): void => {
  if (ghost === null) return;
  // Hover above the pointer so the card stays visible under a finger and
  // never covers the drop target the pointer is resting on.
  ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -130%)`;
};

type DropTarget =
  | { kind: "group"; id: string }
  | { kind: "session"; id: string }
  | { kind: "list" }
  | null;

// Resolve the element under the pointer to a group header, a session card, or
// the list itself — the three valid drop targets.  The ghost carries
// pointer-events: none, so elementFromPoint sees straight through it.
const resolveDropTarget = (x: number, y: number): DropTarget => {
  const base = document.elementFromPoint(x, y);
  if (base === null) return null;
  const groupHeader = base.closest(".group-header");
  if (groupHeader !== null) {
    const id = groupHeader.getAttribute("data-group-id");
    if (id !== null) return { kind: "group", id };
    return null;
  }
  const sessionItem = base.closest(".session-item");
  if (sessionItem !== null && !sessionItem.classList.contains("dragging")) {
    const id = sessionItem.getAttribute("data-session-id");
    if (id !== null) return { kind: "session", id };
    return null;
  }
  if (base.closest("#session-list") !== null) return { kind: "list" };
  return null;
};

const highlightTarget = (x: number, y: number): void => {
  const target = resolveDropTarget(x, y);
  document
    .querySelectorAll(".drag-over")
    .forEach((n) => n.classList.remove("drag-over"));
  if (target === null || target.kind === "list") return;
  const selector =
    target.kind === "group"
      ? `.group-header[data-group-id="${target.id}"]`
      : `.session-item[data-session-id="${target.id}"]`;
  document.querySelector(selector)?.classList.add("drag-over");
};

const performDrop = (sourceId: string, x: number, y: number): void => {
  const target = resolveDropTarget(x, y);
  if (target === null) return;
  if (target.kind === "group")
    postGroupAction(`/sessions/${sourceId}/group`, { groupId: target.id });
  else if (target.kind === "session")
    postGroupAction(`/sessions/${sourceId}/group-with`, {
      otherId: target.id,
    });
  else postGroupAction(`/sessions/${sourceId}/ungroup`, {});
};

document.addEventListener("pointerdown", (e) => {
  if (activeDrag !== null) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  const handle = target.closest(".session-drag-handle");
  if (handle === null) return;
  const item = handle.closest(".session-item");
  if (item === null) return;
  const id = item.getAttribute("data-session-id");
  if (id === null) return;
  activeDrag = {
    sourceId: id,
    sourceEl: item as HTMLElement,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    active: false,
    ghost: null,
  };
});

document.addEventListener("pointermove", (e) => {
  if (activeDrag === null || e.pointerId !== activeDrag.pointerId) return;
  if (!activeDrag.active) {
    const dx = e.clientX - activeDrag.startX;
    const dy = e.clientY - activeDrag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    activeDrag.active = true;
    activeDrag.sourceEl.classList.add("dragging");
    const ghost = createGhost(activeDrag.sourceEl);
    activeDrag.ghost = ghost;
    document.body.append(ghost);
  }
  positionGhost(activeDrag.ghost, e.clientX, e.clientY);
  highlightTarget(e.clientX, e.clientY);
});

const finishDrag = (e: PointerEvent): void => {
  if (activeDrag === null || e.pointerId !== activeDrag.pointerId) return;
  if (activeDrag.active) performDrop(activeDrag.sourceId, e.clientX, e.clientY);
  cleanupDrag();
};

document.addEventListener("pointerup", finishDrag);
document.addEventListener("pointercancel", cleanupDrag);

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
