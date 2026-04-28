import type { PrismTheme, PrismThemeEntry } from "prism-react-renderer";

// Palette-aware Prism theme. Every token color points at a CSS custom
// property so the active theme (`<html data-theme="ember|paper|aether">`
// or any extension-registered theme) can re-skin the highlighter without
// re-rendering the React tree. Extensions that ship their own palette
// just need to set the `--syntax-*` vars on `:root[data-theme=...]`.
const tokenStyle = (
  color: string,
  extra: PrismThemeEntry = {},
): PrismThemeEntry => ({ color, ...extra });

export const aethonPrismTheme: PrismTheme = {
  plain: {
    color: "var(--syntax-text, var(--text))",
    backgroundColor: "transparent",
  },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: tokenStyle("var(--syntax-comment)", { fontStyle: "italic" }) },
    { types: ["punctuation"], style: tokenStyle("var(--syntax-punctuation)") },
    { types: ["namespace"], style: { opacity: 0.7 } },
    { types: ["property", "tag", "boolean", "number", "constant", "symbol", "deleted"], style: tokenStyle("var(--syntax-number)") },
    { types: ["selector", "attr-name", "char", "builtin", "inserted"], style: tokenStyle("var(--syntax-symbol)") },
    { types: ["string"], style: tokenStyle("var(--syntax-string)") },
    { types: ["operator", "entity", "url"], style: tokenStyle("var(--syntax-operator)") },
    { types: ["atrule", "attr-value", "keyword"], style: tokenStyle("var(--syntax-keyword)", { fontWeight: "500" }) },
    { types: ["function", "class-name"], style: tokenStyle("var(--syntax-function)") },
    { types: ["regex", "important", "variable"], style: tokenStyle("var(--syntax-variable)") },
    { types: ["important", "bold"], style: { fontWeight: "700" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
    { types: ["entity"], style: { cursor: "help" } },
  ],
};
