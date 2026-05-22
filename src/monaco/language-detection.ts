/**
 * Resolve a Monaco language id from a file path or extension.
 *
 * Monaco ships its own language registry; we map our supported Shiki
 * grammars to the corresponding Monaco ids so a `.ts` file paints with
 * TypeScript tokenisation and a `.toml` file falls back cleanly. The
 * table is small on purpose — anything Aethon already supports in chat
 * code blocks should round-trip in the editor.
 *
 * Returns `"plaintext"` (Monaco's no-grammar fallback) for unknown
 * extensions so the editor still mounts and the user can edit the file
 * without colour.
 */

const EXTENSION_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cxx: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  dockerfile: "dockerfile",
  nix: "nix",
  lua: "lua",
  zig: "zig",
};

// Filenames that don't have an extension but still want a specific
// language. Keyed by the lowercased basename.
const FILENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "shell",
  ".gitignore": "shell",
  ".env": "shell",
};

/**
 * Resolve a Monaco language id from an absolute or relative file path.
 *
 * Strategy: lowercased basename lookup first (catches `Dockerfile` and
 * `.gitignore`), then extension lookup, then plaintext fallback.
 */
export function languageFromPath(path: string): string {
  if (!path) return "plaintext";
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const lower = basename.toLowerCase();
  if (FILENAME_MAP[lower]) return FILENAME_MAP[lower];
  const dot = lower.lastIndexOf(".");
  if (dot < 0 || dot === lower.length - 1) return "plaintext";
  const ext = lower.slice(dot + 1);
  return EXTENSION_MAP[ext] ?? "plaintext";
}
