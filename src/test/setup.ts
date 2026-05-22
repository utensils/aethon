/** Vitest setup: registers a default invoke + listen mock for `@tauri-apps/api`
 *  so any test that imports App-tier code (where these modules are statically
 *  imported) doesn't blow up trying to call the real Tauri runtime under node /
 *  jsdom. Tests that need to assert on invoke calls override this per-test via
 *  `installTauriMocks()` from `./tauriMocks`.
 *
 *  Defaults: `invoke()` returns undefined (treated as a successful no-op),
 *  `listen()` returns a no-op unlisten. This matches the shape every consumer
 *  expects without coupling the setup to any one event/command. */
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Monaco editor binds to browser globals (document.queryCommandSupported,
// the clipboard API) at module load — JSDOM doesn't ship those, so tests
// that transitively import the EditorCanvas composite would explode. Mock
// monaco-editor + its React wrapper with the minimal surface our code
// actually touches (editor.create / setTheme + the KeyMod/KeyCode enums).
// Tests that exercise the editor directly mock per-test as needed.
vi.mock("monaco-editor", () => {
  const noop = () => ({ dispose: () => {} });
  return {
    editor: {
      create: vi.fn(() => ({
        addCommand: vi.fn(),
        dispose: vi.fn(),
        focus: vi.fn(),
        getModel: vi.fn(() => null),
        getValue: vi.fn(() => ""),
        onDidChangeCursorPosition: vi.fn(noop),
        onDidChangeModelContent: vi.fn(noop),
        restoreViewState: vi.fn(),
        revealPositionInCenter: vi.fn(),
        saveViewState: vi.fn(() => null),
        setModel: vi.fn(),
        setPosition: vi.fn(),
        setValue: vi.fn(),
      })),
      createModel: vi.fn(() => ({
        dispose: vi.fn(),
        getValue: vi.fn(() => ""),
        getValueLength: vi.fn(() => 0),
        setValue: vi.fn(),
      })),
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
    },
    KeyMod: { CtrlCmd: 0 },
    KeyCode: { KeyS: 0 },
  };
});

vi.mock("shiki", () => ({
  createHighlighter: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@shikijs/monaco", () => ({
  shikiToMonaco: vi.fn(),
  textmateThemeToMonacoTheme: vi.fn(
    (theme: {
      type?: string;
      colors?: Record<string, string>;
      settings?: {
        scope?: string | string[];
        settings?: {
          foreground?: string;
          background?: string;
          fontStyle?: string;
        };
      }[];
    }) => ({
      base: theme.type === "light" ? "vs" : "vs-dark",
      inherit: false,
      colors: theme.colors ?? {},
      rules: (theme.settings ?? []).flatMap((entry) => {
        const scopes = Array.isArray(entry.scope)
          ? entry.scope
          : entry.scope
            ? [entry.scope]
            : [];
        return scopes.map((scope) => ({
          token: scope,
          foreground: entry.settings?.foreground?.replace(/^#/, ""),
          background: entry.settings?.background?.replace(/^#/, ""),
          fontStyle: entry.settings?.fontStyle,
        }));
      }),
    }),
  ),
}));

vi.mock("@monaco-editor/react", () => ({
  loader: { config: vi.fn(), init: vi.fn(() => Promise.resolve()) },
}));

// Vite's `?worker` import suffix returns a Worker constructor; in tests
// the suffix is stripped by vitest's resolver and we end up importing
// the worker source module itself, which then explodes on Monaco's
// browser-only globals. Mock the ?worker bundles to harmless stubs.
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  default: class {},
}));
vi.mock("monaco-editor/esm/vs/language/json/json.worker?worker", () => ({
  default: class {},
}));
vi.mock("monaco-editor/esm/vs/language/css/css.worker?worker", () => ({
  default: class {},
}));
vi.mock("monaco-editor/esm/vs/language/html/html.worker?worker", () => ({
  default: class {},
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: class {},
}));
