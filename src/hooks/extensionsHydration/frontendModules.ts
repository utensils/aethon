import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { reconcileFrontendModules } from "../../extensions/extensionFrontendLoader";
import type { ExtensionRegistry } from "../../extensions/ExtensionRegistry";

export interface FrontendModuleStatus {
  name: string;
  status: "loaded" | "failed";
  componentTypes: string[];
  error?: string;
}

export interface FrontendModulesDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  frontendModulesRef: MutableRefObject<Map<string, string>>;
  registry: ExtensionRegistry;
  appendSystem: (text: string) => void;
}

function previousStatuses(
  prev: Record<string, unknown>,
): FrontendModuleStatus[] {
  const raw = prev.extensionFrontendModules;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    if (record.status !== "loaded" && record.status !== "failed") return [];
    const componentTypes = Array.isArray(record.componentTypes)
      ? record.componentTypes.filter(
          (type): type is string => typeof type === "string",
        )
      : [];
    return [
      {
        name: record.name,
        status: record.status,
        componentTypes,
        ...(typeof record.error === "string" ? { error: record.error } : {}),
      },
    ];
  });
}

export function useHydrateFrontendModules(deps: FrontendModulesDeps) {
  const { setState, frontendModulesRef, registry, appendSystem } = deps;
  return function hydrateFrontendModules(
    list: { name: string; code: string }[],
  ) {
    const previous = frontendModulesRef.current;
    const { loaded, unregistered } = reconcileFrontendModules(
      previous,
      list,
      registry,
    );
    frontendModulesRef.current = new Map(list.map((m) => [m.name, m.code]));
    for (const m of loaded) {
      if (m.error) {
        appendSystem(`extension frontend module ${m.name}: ${m.error}`);
      }
    }
    setState((prev) => {
      const unregisteredSet = new Set(unregistered);
      const statuses = new Map(
        previousStatuses(prev)
          .filter((status) => !unregisteredSet.has(status.name))
          .map((status) => [status.name, status]),
      );
      for (const m of loaded) {
        statuses.set(m.name, {
          name: m.name,
          status: m.error ? "failed" : "loaded",
          componentTypes: m.componentTypes,
          ...(m.error ? { error: m.error } : {}),
        });
      }
      const nextStatuses = list.flatMap((m) => {
        const status = statuses.get(m.name);
        return status ? [status] : [];
      });
      return {
        ...prev,
        extensionFrontendModules: nextStatuses,
        ...(loaded.length > 0 || unregistered.length > 0
          ? {
              // Bump a counter so any A2UIRenderer subtree using a now-changed
              // component type re-resolves through the ExtensionRegistry on the
              // next render. The registry itself doesn't trigger React updates;
              // bumping a piece of state owned by App.tsx does.
              extensionModulesGen:
                ((prev.extensionModulesGen as number | undefined) ?? 0) + 1,
            }
          : {}),
      };
    });
  };
}
