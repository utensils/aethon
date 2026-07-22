import { Code } from "aethon";
import type * as React from "react";

/** Preview-only themed surface: the app shell styles `body` with
 *  --bg/--text/--font-ui (chrome base.css), and real designs inherit that
 *  via the styles.css closure — the DS preview harness overrides body to
 *  white, so cards re-create the shell surface locally. */
const Surface = ({ children }: { children?: React.ReactNode }) => (
  <div
    style={{
      background: "var(--bg)",
      color: "var(--text)",
      fontFamily: "var(--font-ui)",
      padding: 16,
      borderRadius: 8,
    }}
  >
    {children}
  </div>
);

const noop = () => {};

const rustSnippet = `fn resolve_inside_root(root: &Path, candidate: &Path) -> Result<PathBuf> {
    let joined = root.join(candidate);
    let normalized = normalize_lexically(&joined)?;
    if !normalized.starts_with(root) {
        bail!("path escapes project root");
    }
    Ok(normalized)
}`;

const tsSnippet = `export function dispatchEvent(route: EventRoute, payload: unknown): boolean {
  const handler = BUILTIN_ROUTE_TABLE[route.key];
  if (!handler) return false; // forward to the bridge
  return handler(payload);
}`;

export const CodeBlock = () => (
  <Surface>
  <div style={{ padding: 8, maxWidth: 640 }}>
    <Code
      component={{
        id: "code-rust",
        type: "code",
        props: { content: rustSnippet, language: "rust" },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);

export const TypeScriptExample = () => (
  <Surface>
  <div style={{ padding: 8, maxWidth: 640 }}>
    <Code
      component={{
        id: "code-ts",
        type: "code",
        props: { content: tsSnippet, language: "typescript" },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);

export const PlainShellLine = () => (
  <Surface>
  <div style={{ padding: 8, maxWidth: 640 }}>
    <Code
      component={{
        id: "code-shell",
        type: "code",
        props: { content: "cargo tauri dev", language: "text" },
      }}
      state={{}}
      onEvent={noop}
    />
  </div>
  </Surface>
);
