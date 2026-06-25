// Settings panel public surface. The only consumer is
// `src/extensions/default-layout/index.ts`, which imports `SettingsPanel`
// from `"./settings-panel"` — this barrel resolves that import to the
// directory's panel implementation. Submodules under this directory
// carry the implementation:
//
//  - `panel.tsx`                    — the main SettingsPanel shell
//  - `*-section.tsx`                 — settings domain sections
//  - `sections.tsx`                  — settings-local section/field UI
//  - `useVoiceProviders.ts`          — voice provider lifecycle state
//  - `devshell-refresh-control.tsx`  — active-project devshell status UI
//  - `state.ts`                     — SettingsState + reader
//  - `constants.ts`                 — theme list + ANSI preview keys
//  - `hooks.ts`                     — useConfigSnapshot / useEffectiveConfig /
//                                     useScrollToSection
//  - `extensions-list.tsx`          — ExtensionsList row renderer
//
// The default model for new sessions is set from the header model picker
// (it persists [agent] model), so there is no model field here.

export { SettingsPanel } from "./panel";
