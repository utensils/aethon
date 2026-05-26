import type { Dispatch, SetStateAction } from "react";
import {
  basenameOfPath,
  classifyExtensionSource,
  disabledExtensionMatchesProject,
  filterExtensionSummariesByProject,
  normalizeDisabledRecord,
  normalizeExtensionProjectPath,
} from "./classification";
import type {
  DisabledExtensionRecord,
  ExtensionFailureSummary,
  ExtensionKind,
  ExtensionSidebarItem,
  ExtensionSummary,
} from "./types";

const CORE_EXTENSION_NAMES = new Set(["default-layout"]);

/** Short label rendered in the per-row hint. Mirrors the `kind` so the
 *  user can tell scope at a glance — `mold:image-gallery` shows
 *  `project`, `@brink/current-context-widget` shows `user`. */
function extensionScopeLabel(kind: ExtensionKind): string {
  return kind;
}

/** Sort comparator for the sidebar extensions list. Project-scoped
 *  rows float to the top (those are the ones the user is most likely
 *  acting on right now), user-scoped come second, alphabetical within
 *  each group. */
const KIND_ORDER: Record<ExtensionKind, number> = {
  project: 0,
  user: 1,
};

function compareSidebarItems(
  a: { kind: ExtensionKind; label: string },
  b: { kind: ExtensionKind; label: string },
): number {
  const ka = KIND_ORDER[a.kind] ?? 99;
  const kb = KIND_ORDER[b.kind] ?? 99;
  if (ka !== kb) return ka - kb;
  return a.label.localeCompare(b.label);
}

export function buildExtensionSidebarItems(
  loaded: ExtensionSummary[],
  failed: ExtensionFailureSummary[],
  disabled: ReadonlyArray<DisabledExtensionRecord | string> = [],
  activeProjectPath: string | null = null,
  knownProjectBasenames: ReadonlySet<string> = new Set(),
): ExtensionSidebarItem[] {
  const scopedLoaded = filterExtensionSummariesByProject(
    loaded,
    activeProjectPath,
    knownProjectBasenames,
  );
  const scopedFailed = filterExtensionSummariesByProject(
    failed,
    activeProjectPath,
    knownProjectBasenames,
  );
  const disabledRecords = disabled.map(normalizeDisabledRecord);
  const disabledSet = new Set(disabledRecords.map((d) => d.name));
  const scopedDisabled = disabledRecords.filter((d) =>
    disabledExtensionMatchesProject(
      d,
      activeProjectPath,
      knownProjectBasenames,
    ),
  );
  // An extension may appear in `loaded` (live this run) but also be
  // marked disabled (toggle landed mid-session, takes effect after
  // restart). Show it in the disabled bucket so the user sees their
  // pending intent, with a hint that a restart is needed to fully
  // unload it.
  //
  // Each row carries `kind` so the sidebar can split into per-origin
  // sub-sections without re-deriving the source on every render.
  // npm packages can land in either bucket: `@<project>/<ext>` where
  // <project> matches the active project's basename folds into the
  // project bucket; everything else (including `@<scope>/...` with an
  // unrelated scope, plain `package-name`, and `~/.aethon/extensions`
  // entries) folds into user. Disabled records carry source through
  // DisabledExtensionRecord.source when known; otherwise we look it
  // up by name against `loaded` for mid-session toggles.
  const activePathForClassify =
    normalizeExtensionProjectPath(activeProjectPath);
  const activeBasenameForClassify = basenameOfPath(activePathForClassify);
  const classifyOpts = (name: string) => ({
    name,
    activeBasename: activeBasenameForClassify,
    knownProjectBasenames,
  });
  const decorated: Array<ExtensionSidebarItem & { kind: ExtensionKind }> = [
    ...scopedLoaded
      .filter((e) => !CORE_EXTENSION_NAMES.has(e.name))
      .filter((e) => !disabledSet.has(e.name))
      .map((e) => {
        const kind = classifyExtensionSource(e.source, classifyOpts(e.name));
        return {
          id: `ext:${e.name}`,
          label: e.name,
          hint: extensionScopeLabel(kind),
          active: true,
          kind,
        };
      }),
    ...scopedFailed
      .filter((e) => !CORE_EXTENSION_NAMES.has(e.name))
      .filter((e) => !disabledSet.has(e.name))
      .map((e) => {
        const kind = classifyExtensionSource(e.source, classifyOpts(e.name));
        return {
          id: `ext-failed:${e.name}`,
          label: e.name,
          hint: `${extensionScopeLabel(kind)} · failed`,
          active: false,
          kind,
        };
      }),
    ...scopedDisabled
      .filter((d) => !CORE_EXTENSION_NAMES.has(d.name))
      .map((d) => {
        const stillLoaded = loaded.some((e) => e.name === d.name);
        // Prefer the source persisted with the disabled record; fall
        // back to the live `loaded` entry for the same name so a
        // mid-session toggle keeps its origin label, then to "user"
        // for legacy records that pre-date source tracking.
        const inferredSource =
          d.source ?? loaded.find((e) => e.name === d.name)?.source;
        const kind = classifyExtensionSource(
          inferredSource,
          classifyOpts(d.name),
        );
        const origin = extensionScopeLabel(kind);
        return {
          id: `ext-disabled:${d.name}`,
          label: d.name,
          hint: stillLoaded
            ? `${origin} · disabled · restart`
            : `${origin} · disabled`,
          active: false,
          kind,
        };
      }),
  ];
  // Keep `kind` on the returned items so the sidebar can split into
  // per-origin sub-sections without re-deriving the source.
  return decorated.sort(compareSidebarItems);
}

export interface HydrateExtensionsDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
}

export function useHydrateExtensions(deps: HydrateExtensionsDeps) {
  const { setState } = deps;
  return function hydrateExtensions(
    loaded: ExtensionSummary[],
    failed: ExtensionFailureSummary[],
    disabled: ReadonlyArray<DisabledExtensionRecord | string> = [],
    activeProjectPath: string | null = null,
    knownProjectBasenames: ReadonlySet<string> = new Set(),
  ) {
    const items = buildExtensionSidebarItems(
      loaded,
      failed,
      disabled,
      activeProjectPath,
      knownProjectBasenames,
    );
    setState((prev) => {
      const sidebar = (prev.sidebar as Record<string, unknown>) ?? {};
      return { ...prev, sidebar: { ...sidebar, extensions: items } };
    });
  };
}
