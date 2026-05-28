/**
 * Extension loader public surface. Discovery + loading for Aethon
 * extensions across all four sources, plus loose-file themes. The full
 * docstring for each source lives on the submodule that implements it:
 *
 *  - shared.ts    — ExtensionLoaderDeps + LoadHooks interfaces
 *  - themes.ts    — RESERVED_THEME_IDS, normalizeTheme,
 *                   loadAethonThemeDirectory (loose-file themes)
 *  - directory.ts — loadAethonExtensionDirectory + the user-dir
 *                   (`~/.aethon/extensions/`) and project-dir
 *                   (`<project>/.aethon/extensions/`) wrappers, plus
 *                   projectExtensionDisplayName
 *  - packages.ts  — loadAethonExtensionPackages (npm-style under
 *                   `~/.aethon/extensions/node_modules/`)
 *  - discovery.ts — discoverPiAethonExtensions (greps `~/.pi/agent/`)
 *                   + discoverPersistedTabs
 *
 * External callers keep importing from `"./extension-loader"`; this
 * barrel resolves their imports to the directory's index.
 */

export type { ExtensionLoaderDeps, LoadHooks } from "./shared";
export { RESERVED_THEME_IDS, normalizeTheme, loadAethonThemeDirectory } from "./themes";
export {
  loadAethonExtensionDirectory,
  loadAethonExtensions,
  loadProjectAethonExtensions,
  projectExtensionDisplayName,
} from "./directory";
export { loadAethonExtensionPackages } from "./packages";
export { discoverPersistedTabs, discoverPiAethonExtensions } from "./discovery";
