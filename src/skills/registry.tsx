/**
 * SkillRegistry React provider — pure component module.
 *
 * The class + hook live in `SkillRegistry.ts` so Vite's react-refresh
 * lint rule sees this file as a single-responsibility component module
 * and skips the false-positive about non-component exports.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { SkillRegistry } from "./SkillRegistry";
import { SkillRegistryContext } from "./SkillRegistry";

export function SkillRegistryProvider({
  registry,
  children,
}: {
  registry: SkillRegistry;
  children: ReactNode;
}) {
  // Pin the registry instance per-mount so context consumers stay stable.
  const [pinned] = useState(() => registry);
  return (
    <SkillRegistryContext.Provider value={pinned}>
      {children}
    </SkillRegistryContext.Provider>
  );
}
