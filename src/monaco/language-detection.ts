/**
 * Resolve a Monaco language id from a file path or extension.
 *
 * Monaco ships its own language registry; we map our supported Shiki
 * grammars to the corresponding Monaco ids so a `.ts` file paints with
 * TypeScript tokenisation and a `.toml` file paints with the TOML
 * grammar. Every id this table can return is registered with Monaco and
 * backed by a loaded Shiki grammar in `shiki.ts` (the binding only takes
 * effect for ids Monaco already knows about — see `registerEditorLanguages`).
 *
 * Returns `"plaintext"` (Monaco's no-grammar fallback) for unknown
 * extensions so the editor still mounts and the user can edit the file
 * without colour.
 *
 * `.tsx`/`.jsx` deliberately resolve to `typescript`/`javascript` so
 * Monaco's TS language service (diagnostics, hover, completion) still
 * attaches; Shiki overrides only the syntactic tokeniser for those ids.
 */

const EXTENSION_MAP: Record<string, string> = {
  // Web / TS-JS family (kept on typescript/javascript so the TS worker runs)
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  css: "css",
  scss: "scss",
  less: "less",
  // Docs / markup
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  tex: "latex",
  // Scripting
  py: "python",
  pyi: "python",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  pl: "perl",
  pm: "perl",
  lua: "lua",
  r: "r",
  jl: "julia",
  // Systems
  rs: "rust",
  go: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  zig: "zig",
  d: "c",
  // JVM / .NET
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  sbt: "scala",
  groovy: "groovy",
  gradle: "groovy",
  cs: "csharp",
  fs: "fsharp",
  fsx: "fsharp",
  // Apple
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  // Functional / other
  hs: "haskell",
  ml: "ocaml",
  mli: "ocaml",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hrl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  edn: "clojure",
  dart: "dart",
  // Web3
  sol: "solidity",
  prisma: "prisma",
  // Backend / data
  php: "php",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  // Shell
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  // Config / infra
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  properties: "ini",
  xml: "xml",
  plist: "xml",
  svg: "xml",
  dockerfile: "dockerfile",
  nix: "nix",
  tf: "terraform",
  tfvars: "terraform",
  hcl: "hcl",
  cmake: "cmake",
  vim: "viml",
  // Patches
  diff: "diff",
  patch: "diff",
};

// Filenames that don't have an extension (or want a specific grammar
// regardless of extension). Keyed by the lowercased basename.
const FILENAME_MAP: Record<string, string> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "make",
  "gnumakefile": "make",
  "cmakelists.txt": "cmake",
  ".gitignore": "ini",
  ".gitattributes": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".env": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".bash_profile": "shell",
  ".profile": "shell",
  ".vimrc": "viml",
  "nginx.conf": "nginx",
  "cargo.lock": "toml",
  "go.mod": "go",
  "go.sum": "go",
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

/**
 * Every Monaco language id `languageFromPath` can return (minus the
 * `plaintext` fallback). `shiki.ts` registers each of these with Monaco
 * before binding Shiki grammars so model assignment never produces an
 * unknown — and therefore untokenised — language id.
 */
export const EDITOR_LANGUAGE_IDS: string[] = Array.from(
  new Set<string>([...Object.values(EXTENSION_MAP), ...Object.values(FILENAME_MAP)]),
);
