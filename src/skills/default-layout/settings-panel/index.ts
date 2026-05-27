// Settings panel public surface. The only consumer is
// `src/skills/default-layout/index.ts`, which imports `SettingsPanel`
// from `"./settings-panel"` — this barrel resolves that import to the
// directory's panel implementation. Submodules under this directory
// carry the implementation:
//
//  - `panel.tsx`           — the main SettingsPanel component
//  - `state.ts`            — SettingsState + reader
//  - `constants.ts`        — theme list + ANSI preview keys
//  - `hooks.ts`            — useConfigSnapshot / useEffectiveConfig /
//                            useScrollToSection
//  - `model-picker.tsx`    — ModelPicker dropdown / custom-mode input
//  - `extensions-list.tsx` — ExtensionsList row renderer

export { SettingsPanel } from "./panel";
