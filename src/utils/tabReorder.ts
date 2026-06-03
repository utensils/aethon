import type { TabKind } from "../types/tab";

export type TabReorderItem = { id: string; kind?: TabKind };

export type TabReorderGroup = "top" | "shell";

function isInGroup(tab: TabReorderItem, group: TabReorderGroup): boolean {
  const kind = tab.kind ?? "agent";
  return group === "shell" ? kind === "shell" : kind !== "shell";
}

function reorderWithinGroup<T extends TabReorderItem>(
  tabs: readonly T[],
  group: TabReorderGroup,
  reorderMatching: (items: T[]) => T[] | null,
): T[] | null {
  const groupItems = tabs.filter((tab) => isInGroup(tab, group));
  if (groupItems.length <= 1) return null;

  const reordered = reorderMatching(groupItems.slice());
  if (!reordered) return null;

  const changed = reordered.some(
    (tab, index) => tab.id !== groupItems[index]?.id,
  );
  if (!changed) return null;

  let groupIndex = 0;
  return tabs.map((tab) =>
    isInGroup(tab, group) ? reordered[groupIndex++] : tab,
  );
}

/**
 * Reorder a tab within one logical tab surface while preserving every
 * other surface's slots. Top-strip reorders only non-shell tabs; terminal
 * reorders only shell tabs. `toIndex` is the destination index in the
 * matching group after the dragged tab has been removed.
 */
export function reorderTabToIndex<T extends TabReorderItem>(
  tabs: readonly T[],
  group: TabReorderGroup,
  tabId: string,
  toIndex: number,
): T[] | null {
  if (!tabId || !Number.isFinite(toIndex)) return null;
  return reorderWithinGroup(tabs, group, (items) => {
    const fromIndex = items.findIndex((tab) => tab.id === tabId);
    if (fromIndex < 0) return null;
    const [moved] = items.splice(fromIndex, 1);
    const targetIndex = Math.max(
      0,
      Math.min(items.length, Math.trunc(toIndex)),
    );
    items.splice(targetIndex, 0, moved);
    return items;
  });
}

/** Move a tab one slot within a logical surface, wrapping at the ends. */
export function reorderTabByDirection<T extends TabReorderItem>(
  tabs: readonly T[],
  group: TabReorderGroup,
  tabId: string,
  direction: 1 | -1,
): T[] | null {
  if (!tabId) return null;
  return reorderWithinGroup(tabs, group, (items) => {
    const fromIndex = items.findIndex((tab) => tab.id === tabId);
    if (fromIndex < 0) return null;
    const destination = (fromIndex + direction + items.length) % items.length;
    const [moved] = items.splice(fromIndex, 1);
    const toIndex =
      direction === 1 && destination === 0
        ? 0
        : direction === -1 && destination === items.length
          ? items.length
          : destination;
    items.splice(toIndex, 0, moved);
    return items;
  });
}
