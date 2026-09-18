import { getHtmx } from "./htmx.js";
import { onSessionListSwap } from "./shared";

const postGroupAction = (
  path: string,
  values: Record<string, string>,
): void => {
  const htmx = getHtmx();
  if (htmx === undefined) return;
  htmx.ajax("POST", path, {
    target: "#session-list",
    swap: "outerHTML",
    values,
  });
};

// ---- drag to group (pointer events: mouse + touch) ----
// Native HTML5 drag-and-drop never fires on touch, so pointer events drive
// grouping across every input type. The drag handle (touch-action: none)
// keeps list scrolling usable: a gesture starting on it drags, not scrolls.

const DRAG_THRESHOLD_PX = 6;

type ActiveDrag = {
  sourceId: string;
  sourceEl: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  grabOffsetX: number;
  grabOffsetY: number;
  ghost: HTMLElement | null;
};

let activeDrag: ActiveDrag | null = null;

// A handle gesture synthesizes a `click` that lands on the stretched session
// link and would navigate to the detail pane — suppress it.
let suppressClick = false;

const cleanupDrag = (): void => {
  if (activeDrag === null) return;
  activeDrag.ghost?.remove();
  document.querySelectorAll(".dragging, .drag-over").forEach((el) => {
    el.classList.remove("dragging", "drag-over");
  });
  activeDrag = null;
};

// On touch the finger hides the source, so a clone tracks the pointer.
const createGhost = (source: HTMLElement): HTMLElement => {
  const ghost = source.cloneNode(true);
  // cloneNode is typed as Node; an HTMLElement always clones to one, so
  // re-prove it here rather than cast on faith.
  if (!(ghost instanceof HTMLElement))
    throw new Error("drag ghost clone is not an HTMLElement");
  ghost.classList.remove("dragging");
  ghost.classList.add("drag-ghost");
  ghost.style.width = `${source.getBoundingClientRect().width}px`;
  return ghost;
};

const positionGhost = (
  ghost: HTMLElement | null,
  x: number,
  y: number,
  offsetX: number,
  offsetY: number,
): void => {
  if (ghost === null) return;
  ghost.style.transform = `translate(${x - offsetX}px, ${y - offsetY}px)`;
};

type DropTarget =
  | { el: Element; id: string; kind: "group" }
  | { el: Element; id: string; kind: "session" }
  | { kind: "list" }
  | null;

// The ghost has pointer-events: none, so elementFromPoint sees through it.
const resolveDropTarget = (x: number, y: number): DropTarget => {
  const base = document.elementFromPoint(x, y);
  if (base === null) return null;
  const groupHeader = base.closest(".group-header");
  if (groupHeader !== null) {
    const id = groupHeader.getAttribute("data-group-id");
    return id === null ? null : { el: groupHeader, id, kind: "group" };
  }
  const sessionItem = base.closest(".session-item");
  // Releasing over the dragged card itself — the pointer rarely leaves it on
  // a short drag — is a no-op, not a drop on the list background (which
  // would silently ungroup the session).
  if (sessionItem === activeDrag?.sourceEl) return null;
  if (sessionItem !== null && !sessionItem.classList.contains("dragging")) {
    const id = sessionItem.getAttribute("data-session-id");
    return id === null ? null : { el: sessionItem, id, kind: "session" };
  }
  if (base.closest("#session-list") !== null) return { kind: "list" };
  return null;
};

const highlightTarget = (x: number, y: number): void => {
  const target = resolveDropTarget(x, y);
  document
    .querySelectorAll(".drag-over")
    .forEach((n) => n.classList.remove("drag-over"));
  if (target !== null && target.kind !== "list")
    target.el.classList.add("drag-over");
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
  // Clear any flag left by a prior gesture that never synthesized a click.
  suppressClick = false;
  if (activeDrag !== null) return;
  const target = e.target;
  if (!(target instanceof Element)) return;
  const handle = target.closest(".session-drag-handle");
  if (handle === null) return;
  const item = handle.closest(".session-item");
  if (item === null) return;
  if (!(item instanceof HTMLElement)) return;
  const id = item.getAttribute("data-session-id");
  if (id === null) return;
  suppressClick = true;
  activeDrag = {
    sourceId: id,
    sourceEl: item,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    grabOffsetX: 0,
    grabOffsetY: 0,
    ghost: null,
  };
});

document.addEventListener("pointermove", (e) => {
  if (activeDrag === null || e.pointerId !== activeDrag.pointerId) return;
  if (activeDrag.ghost === null) {
    const dx = e.clientX - activeDrag.startX;
    const dy = e.clientY - activeDrag.startY;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    activeDrag.sourceEl.classList.add("dragging");
    // Keep the grab point under the cursor so the ghost is born in place.
    const rect = activeDrag.sourceEl.getBoundingClientRect();
    activeDrag.grabOffsetX = activeDrag.startX - rect.left;
    activeDrag.grabOffsetY = activeDrag.startY - rect.top;
    const ghost = createGhost(activeDrag.sourceEl);
    activeDrag.ghost = ghost;
    document.body.append(ghost);
  }
  positionGhost(
    activeDrag.ghost,
    e.clientX,
    e.clientY,
    activeDrag.grabOffsetX,
    activeDrag.grabOffsetY,
  );
  highlightTarget(e.clientX, e.clientY);
});

const finishDrag = (e: PointerEvent): void => {
  if (activeDrag === null || e.pointerId !== activeDrag.pointerId) return;
  if (activeDrag.ghost !== null)
    performDrop(activeDrag.sourceId, e.clientX, e.clientY);
  cleanupDrag();
};

document.addEventListener("pointerup", finishDrag);
document.addEventListener("pointercancel", cleanupDrag);

// Capture phase beats htmx's bubble-phase listener, so the click dies here.
document.addEventListener(
  "click",
  (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

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
  const toggleBtn = el?.closest("[data-action='toggle-group']");
  if (toggleBtn instanceof HTMLElement) {
    e.preventDefault();
    e.stopPropagation();
    const group = toggleBtn.closest(".session-group");
    if (group === null) return;
    const groupId = group.getAttribute("data-group-id");
    if (groupId === null) return;
    toggleCollapsed(group, groupId);
  }
});

// Re-apply collapsed state after any swap (main or out-of-band) replaces
// the session list.
onSessionListSwap(applyCollapsedState);

// Script is deferred, so the DOM is ready.
applyCollapsedState();
