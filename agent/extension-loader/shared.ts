/**
 * Shared types for the extension-loader submodules. The deps shape +
 * the hook contract are referenced by every loader (directory, package,
 * theme, discovery), so they live in one place to avoid cross-imports
 * between sibling modules.
 */

import type { ExtensionFailure, ExtensionFailureSource } from "../state";

export interface ExtensionLoaderDeps {
  send: (obj: Record<string, unknown>) => void;
}

export interface LoadHooks {
  onLoaded?: (name: string) => void;
  onProjectLoaded?: (name: string, projectRoot: string) => void;
  onFailure?: (
    failure: ExtensionFailure & { name: string; source: ExtensionFailureSource },
  ) => void;
}
