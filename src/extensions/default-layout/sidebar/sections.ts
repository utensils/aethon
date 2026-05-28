/**
 * Pure section composition for the sidebar. Reads inline sections,
 * extra-sections ($ref or array), and the auto-injected extensions
 * list, returning the flat list the renderer iterates.
 *
 * The extensions list is split into one section per origin (project /
 * user). Items carry `kind` from buildExtensionSidebarItems; legacy
 * items lacking the field fall back to "user" so a stale upstream
 * array still groups sensibly.
 *
 * Skipped entirely when the layout already declares an `extensions`
 * section — otherwise the auto-injection would duplicate it.
 */

import type {
  SidebarItem,
  SidebarSection,
} from "../../../types/a2ui";
import { resolvePointer } from "../../../utils/jsonPointer";
import type { SidebarSectionExt } from "./searchable-section";

export interface ComposeSidebarSectionsInput {
  sections: SidebarSectionExt[] | undefined;
  extraSectionsRaw: SidebarSection[] | { $ref: string } | undefined;
  state: Record<string, unknown>;
}

export function composeSidebarSections(
  input: ComposeSidebarSectionsInput,
): SidebarSectionExt[] {
  const { sections, extraSectionsRaw, state } = input;
  const extraSections = resolveExtraSections(extraSectionsRaw, state);
  const extensionItems = readExtensionItems(state);
  const hasExplicitExtensionSection = [
    ...(sections ?? []),
    ...(extraSections as SidebarSectionExt[]),
  ].some((section) => section.id === "extensions");
  const extensionSections: SidebarSectionExt[] =
    extensionItems.length > 0 && !hasExplicitExtensionSection
      ? buildExtensionSections(extensionItems)
      : [];
  return [
    ...(sections ?? []),
    ...extensionSections,
    ...(extraSections as SidebarSectionExt[]),
  ];
}

/** Resolve a SidebarSection["items"] field — either inline array or
 *  `{ $ref }` pointer into state. Returns [] for anything else so the
 *  renderer can fall through to the empty-state. */
export function resolveSidebarItems(
  items: SidebarSection["items"] | undefined,
  state: Record<string, unknown>,
): SidebarItem[] {
  if (!items) return [];
  if (Array.isArray(items)) return items;
  if (typeof items !== "object" || !("$ref" in items)) return [];
  const ref = (items as { $ref: unknown }).$ref;
  if (typeof ref !== "string") return [];
  const resolved = resolvePointer(state, ref);
  return Array.isArray(resolved) ? (resolved as SidebarItem[]) : [];
}

function resolveExtraSections(
  raw: SidebarSection[] | { $ref: string } | undefined,
  state: Record<string, unknown>,
): SidebarSection[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const ref = (raw as { $ref: unknown }).$ref;
  if (typeof ref !== "string") return [];
  const resolved = resolvePointer(state, ref);
  return Array.isArray(resolved) ? (resolved as SidebarSection[]) : [];
}

function readExtensionItems(state: Record<string, unknown>): SidebarItem[] {
  const sidebar = (state.sidebar as Record<string, unknown> | undefined) ?? {};
  const raw = sidebar.extensions;
  return Array.isArray(raw) ? (raw as SidebarItem[]) : [];
}

function buildExtensionSections(items: SidebarItem[]): SidebarSectionExt[] {
  const buckets: Record<"project" | "user", SidebarItem[]> = {
    project: [],
    user: [],
  };
  for (const item of items) {
    const kind = ((item as { kind?: string }).kind ?? "user") as
      | "project"
      | "user";
    (buckets[kind] ?? buckets.user).push(item);
  }
  // Always show the qualified group title so the user can tell scope at
  // a glance even when only one bucket has rows. The alternative —
  // collapsing to a bare "extensions" — loses that information exactly
  // when there's only one extension loaded, which is when its origin
  // is most informative.
  const titleFor = (kind: "project" | "user"): string =>
    kind === "project" ? "project extensions" : "user extensions";
  const sections: SidebarSectionExt[] = [];
  if (buckets.project.length > 0) {
    sections.push({
      id: "extensions",
      title: titleFor("project"),
      items: buckets.project,
    });
  }
  if (buckets.user.length > 0) {
    sections.push({
      id: "extensions-user",
      title: titleFor("user"),
      items: buckets.user,
    });
  }
  return sections;
}
