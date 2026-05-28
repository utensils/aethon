import type { SidebarItem } from "../../../types/a2ui";

// Extracts the leading "provider" segment from an item id like
// `claude-sonnet-4-5` → "claude" or `gpt-5-pro` → "gpt". Falls back to
// label-derived prefix; returns "other" when there's nothing useful.
export function providerOf(item: SidebarItem): string {
  const id = item.id ?? "";
  const dash = id.indexOf("-");
  const slash = id.indexOf("/");
  if (slash > 0) return id.slice(0, slash).toLowerCase();
  if (dash > 0) return id.slice(0, dash).toLowerCase();
  if (id) return id.toLowerCase();
  return "other";
}

// Filter helper used by the searchable sidebar section. Matches against
// the item id AND label so a user can find `claude-sonnet-4-5` by typing
// "sonnet". Empty query returns the full list unchanged.
export function filterItems(items: SidebarItem[], query: string): SidebarItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const id = (it.id ?? "").toLowerCase();
    const label = (it.label ?? "").toLowerCase();
    return id.includes(q) || label.includes(q);
  });
}
