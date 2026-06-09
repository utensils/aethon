/**
 * Layout primitives for the default-layout extension — the CSS-grid `Layout`
 * container, the inline Æπ brand monogram, the `--app-ui-scale` reader,
 * plus the small chrome composites that share the same root semantics
 * (`StatusBar`, `EmptyState`, `WorkspaceLanding`).
 *
 * This is the public surface previously served by `layout.tsx`; submodules
 * under this directory carry the implementations. Callers keep importing
 * from `./layout` / `../layout` and resolve here unchanged.
 */

export { AeMarkInline, AeWordmark, readUiScale } from "./mark";
export { Layout } from "./grid";
export { StatusBar } from "./status-bar";
export { EmptyState } from "./empty-state";
export { WorkspaceLanding } from "./workspace-landing";
