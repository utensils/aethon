import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { reconcileFrontendModules } from "../../extensions/extensionFrontendLoader";
import type { ExtensionRegistry } from "../../extensions/ExtensionRegistry";

export interface FrontendModulesDeps {
  setState: Dispatch<SetStateAction<Record<string, unknown>>>;
  frontendModulesRef: MutableRefObject<Map<string, string>>;
  registry: ExtensionRegistry;
  appendSystem: (text: string) => void;
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
    if (loaded.length > 0 || unregistered.length > 0) {
      // Bump a counter so any A2UIRenderer subtree using a now-changed
      // component type re-resolves through the ExtensionRegistry on the
      // next render. The registry itself doesn't trigger React updates;
      // bumping a piece of state owned by App.tsx does.
      setState((prev) => ({
        ...prev,
        extensionModulesGen:
          ((prev.extensionModulesGen as number | undefined) ?? 0) + 1,
      }));
    }
  };
}
