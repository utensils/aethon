import type { MutableRefObject } from "react";
import { normalizeRegisteredCombo } from "../../utils/keybindings";

export interface KeybindingsDeps {
  extensionKeybindingsRef: MutableRefObject<
    Map<string, { combo: string; action: string; description?: string }>
  >;
}

export function useHydrateKeybindings(deps: KeybindingsDeps) {
  const { extensionKeybindingsRef } = deps;
  return function hydrateKeybindings(
    list: { combo: string; action: string; description?: string }[],
  ) {
    const next = new Map<
      string,
      { combo: string; action: string; description?: string }
    >();
    for (const b of list) {
      const canonical = normalizeRegisteredCombo(b.combo);
      if (!canonical) continue;
      next.set(canonical, { ...b, combo: canonical });
    }
    extensionKeybindingsRef.current = next;
  };
}
