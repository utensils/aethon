import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { A2UIComponent } from "./types/a2ui";

export const CANVAS_WINDOW_SURFACE_PREFIX = "canvas-window:";

export interface NativeCanvasWindowRecord {
  id: string;
  label: string;
  kind: "canvas";
  title: string;
  tabId?: string;
  restoreOnLaunch: boolean;
  components: A2UIComponent[];
  state: Record<string, unknown>;
}

export interface NativeCanvasWindowSummary {
  id: string;
  label: string;
  kind: "canvas";
  title: string;
  tabId?: string;
  restoreOnLaunch: boolean;
  componentCount: number;
}

export type NativeWindowsRef = MutableRefObject<
  Map<string, NativeCanvasWindowRecord>
>;

function normalizeComponent(
  value: unknown,
  index: number,
): A2UIComponent | null {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { type?: unknown }).type !== "string"
  ) {
    return null;
  }
  const component = value as A2UIComponent & { id?: unknown };
  return {
    ...component,
    id:
      typeof component.id === "string" && component.id.length > 0
        ? component.id
        : `${component.type}-${index}`,
  };
}

export function normalizeCanvasComponents(input: unknown): A2UIComponent[] {
  const raw =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Array.isArray((input as { components?: unknown }).components)
      ? (input as { components: unknown[] }).components
      : Array.isArray(input)
        ? input
        : input === undefined || input === null
          ? []
          : [input];
  return raw
    .map((item, index) => normalizeComponent(item, index))
    .filter((item): item is A2UIComponent => item !== null);
}

export function normalizeWindowState(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? { ...(input as Record<string, unknown>) }
    : {};
}

export function summarizeNativeWindow(
  record: NativeCanvasWindowRecord,
): NativeCanvasWindowSummary {
  return {
    id: record.id,
    label: record.label,
    kind: record.kind,
    title: record.title,
    ...(record.tabId ? { tabId: record.tabId } : {}),
    restoreOnLaunch: record.restoreOnLaunch,
    componentCount: record.components.length,
  };
}

export function nativeWindowSummaries(
  records: Iterable<NativeCanvasWindowRecord>,
): NativeCanvasWindowSummary[] {
  return [...records]
    .map(summarizeNativeWindow)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function syncNativeWindowsToState(
  setState: Dispatch<SetStateAction<Record<string, unknown>>>,
  nativeWindowsRef: NativeWindowsRef,
): void {
  const nativeWindows = nativeWindowSummaries(
    nativeWindowsRef.current.values(),
  );
  setState((prev) => ({ ...prev, nativeWindows }));
}

export function canvasWindowSurfaceId(id: string): string {
  return `${CANVAS_WINDOW_SURFACE_PREFIX}${id}`;
}

export function terminalShellTabIds(
  record: NativeCanvasWindowRecord | undefined,
): string[] {
  if (!record) return [];
  const componentIds = new Set<string>();
  for (const component of record.components) {
    if (
      component &&
      typeof component === "object" &&
      (component as { type?: unknown }).type === "shell-canvas"
    ) {
      const props = (component as { props?: Record<string, unknown> }).props;
      if (typeof props?.tabId === "string") componentIds.add(props.tabId);
    }
  }
  if (componentIds.size === 0) return [];
  const tabs = (record.state as { tabs?: unknown }).tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs
    .filter(
      (tab): tab is { id: string; kind?: string } =>
        Boolean(tab) &&
        typeof tab === "object" &&
        typeof (tab as { id?: unknown }).id === "string" &&
        componentIds.has((tab as { id: string }).id) &&
        (tab as { kind?: unknown }).kind === "shell",
    )
    .map((tab) => tab.id);
}
