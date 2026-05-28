/**
 * ExtensionRegistry React provider — pure component module.
 *
 * The class + hook live in `ExtensionRegistry.ts` so Vite's react-refresh
 * lint rule sees this file as a single-responsibility component module
 * and skips the false-positive about non-component exports.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { ExtensionRegistry } from "./ExtensionRegistry";
import { ExtensionRegistryContext } from "./ExtensionRegistry";

export function ExtensionRegistryProvider({
  registry,
  children,
}: {
  registry: ExtensionRegistry;
  children: ReactNode;
}) {
  // Pin the registry instance per-mount so context consumers stay stable.
  const [pinned] = useState(() => registry);
  return (
    <ExtensionRegistryContext.Provider value={pinned}>
      {children}
    </ExtensionRegistryContext.Provider>
  );
}
