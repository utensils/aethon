/**
 * File-icon manifest — maps basenames + extensions → bundled SVG URLs.
 *
 * Each SVG is imported as a URL via Vite's asset pipeline; the build
 * inlines them into the bundle. Unknown types fall back to `file.svg`
 * (file) or `folder.svg` (directory).
 *
 * The icon set is vendored from PKief/vscode-material-icon-theme (MIT).
 * See SOURCE.md for the vendoring policy.
 */

// File-type icons
import audioIcon from "./icons/audio.svg";
import bashIcon from "./icons/bash.svg";
import cIcon from "./icons/c.svg";
import cppIcon from "./icons/cpp.svg";
import csharpIcon from "./icons/csharp.svg";
import cssIcon from "./icons/css.svg";
import databaseIcon from "./icons/database.svg";
import dockerIcon from "./icons/docker.svg";
import editorconfigIcon from "./icons/editorconfig.svg";
import fileIcon from "./icons/file.svg";
import fontIcon from "./icons/font.svg";
import gitIcon from "./icons/git.svg";
import goIcon from "./icons/go.svg";
import graphqlIcon from "./icons/graphql.svg";
import htmlIcon from "./icons/html.svg";
import imageIcon from "./icons/image.svg";
import iniIcon from "./icons/ini.svg";
import javaIcon from "./icons/java.svg";
import javascriptIcon from "./icons/javascript.svg";
import jsonIcon from "./icons/json.svg";
import keyIcon from "./icons/key.svg";
import kotlinIcon from "./icons/kotlin.svg";
import lessIcon from "./icons/less.svg";
import libIcon from "./icons/lib.svg";
import licenseIcon from "./icons/license.svg";
import lockIcon from "./icons/lock.svg";
import logIcon from "./icons/log.svg";
import makefileIcon from "./icons/makefile.svg";
import markdownIcon from "./icons/markdown.svg";
import nixIcon from "./icons/nix.svg";
import npmIcon from "./icons/npm.svg";
import pdfIcon from "./icons/pdf.svg";
import powershellIcon from "./icons/powershell.svg";
import prismaIcon from "./icons/prisma.svg";
import pythonIcon from "./icons/python.svg";
import reactIcon from "./icons/react.svg";
import reactTsIcon from "./icons/react_ts.svg";
import readmeIcon from "./icons/readme.svg";
import rubyIcon from "./icons/ruby.svg";
import rustIcon from "./icons/rust.svg";
import scssIcon from "./icons/scss.svg";
import settingsIcon from "./icons/settings.svg";
import shellIcon from "./icons/shell.svg";
import sveltedIcon from "./icons/svelte.svg";
import swiftIcon from "./icons/swift.svg";
import tomlIcon from "./icons/toml.svg";
import typescriptIcon from "./icons/typescript.svg";
import videoIcon from "./icons/video.svg";
import vscodeIcon from "./icons/vscode.svg";
import vueIcon from "./icons/vue.svg";
import xmlIcon from "./icons/xml.svg";
import yamlIcon from "./icons/yaml.svg";
import yarnIcon from "./icons/yarn.svg";
import zipIcon from "./icons/zip.svg";

// Folder icons
import folderIcon from "./icons/folder.svg";
import folderOpenIcon from "./icons/folder-open.svg";
import folderRootIcon from "./icons/folder-root.svg";
import folderRootOpenIcon from "./icons/folder-root-open.svg";

/** Generic fallbacks — always available. */
export const FALLBACK_FILE = fileIcon;
export const FALLBACK_FOLDER = folderIcon;
export const FALLBACK_FOLDER_OPEN = folderOpenIcon;
export const FALLBACK_FOLDER_ROOT = folderRootIcon;
export const FALLBACK_FOLDER_ROOT_OPEN = folderRootOpenIcon;

/** Match by exact basename (case-insensitive). Highest priority. */
export const BY_BASENAME: Record<string, string> = {
  // Build + tooling
  "package.json": npmIcon,
  "package-lock.json": npmIcon,
  "yarn.lock": yarnIcon,
  "bun.lockb": npmIcon,
  "pnpm-lock.yaml": yarnIcon,
  "cargo.toml": rustIcon,
  "cargo.lock": rustIcon,
  "go.mod": goIcon,
  "go.sum": goIcon,
  "pyproject.toml": pythonIcon,
  "requirements.txt": pythonIcon,
  "gemfile": rubyIcon,
  "gemfile.lock": rubyIcon,
  "flake.nix": nixIcon,
  "flake.lock": nixIcon,
  "shell.nix": nixIcon,
  "default.nix": nixIcon,
  "dockerfile": dockerIcon,
  "containerfile": dockerIcon,
  "docker-compose.yml": dockerIcon,
  "docker-compose.yaml": dockerIcon,
  "makefile": makefileIcon,
  "rakefile": rubyIcon,
  "justfile": makefileIcon,
  // Editor + linter configs
  ".editorconfig": editorconfigIcon,
  ".gitignore": gitIcon,
  ".gitattributes": gitIcon,
  ".gitmodules": gitIcon,
  ".npmignore": npmIcon,
  ".npmrc": npmIcon,
  ".env": settingsIcon,
  ".env.local": settingsIcon,
  ".env.production": settingsIcon,
  ".env.development": settingsIcon,
  "tsconfig.json": typescriptIcon,
  "tsconfig.app.json": typescriptIcon,
  "tsconfig.node.json": typescriptIcon,
  "vite.config.ts": vscodeIcon,
  "vite.config.js": vscodeIcon,
  "vitest.config.ts": vscodeIcon,
  "eslint.config.js": vscodeIcon,
  "eslint.config.ts": vscodeIcon,
  "prettier.config.js": vscodeIcon,
  ".prettierrc": vscodeIcon,
  // Docs
  "readme.md": readmeIcon,
  "readme": readmeIcon,
  "readme.txt": readmeIcon,
  "license": licenseIcon,
  "license.md": licenseIcon,
  "license.txt": licenseIcon,
  "changelog.md": markdownIcon,
};

/** Match by file extension (lowercase, no leading dot). */
export const BY_EXTENSION: Record<string, string> = {
  ts: typescriptIcon,
  mts: typescriptIcon,
  cts: typescriptIcon,
  tsx: reactTsIcon,
  js: javascriptIcon,
  mjs: javascriptIcon,
  cjs: javascriptIcon,
  jsx: reactIcon,
  rs: rustIcon,
  py: pythonIcon,
  pyi: pythonIcon,
  rb: rubyIcon,
  go: goIcon,
  swift: swiftIcon,
  kt: kotlinIcon,
  kts: kotlinIcon,
  java: javaIcon,
  c: cIcon,
  h: cIcon,
  cpp: cppIcon,
  cc: cppIcon,
  cxx: cppIcon,
  hpp: cppIcon,
  cs: csharpIcon,
  nix: nixIcon,
  toml: tomlIcon,
  json: jsonIcon,
  jsonc: jsonIcon,
  json5: jsonIcon,
  yml: yamlIcon,
  yaml: yamlIcon,
  xml: xmlIcon,
  ini: iniIcon,
  conf: iniIcon,
  cfg: iniIcon,
  md: markdownIcon,
  mdx: markdownIcon,
  markdown: markdownIcon,
  html: htmlIcon,
  htm: htmlIcon,
  css: cssIcon,
  scss: scssIcon,
  sass: scssIcon,
  less: lessIcon,
  sh: shellIcon,
  zsh: shellIcon,
  fish: shellIcon,
  bash: bashIcon,
  ps1: powershellIcon,
  vue: vueIcon,
  svelte: sveltedIcon,
  prisma: prismaIcon,
  graphql: graphqlIcon,
  gql: graphqlIcon,
  sql: databaseIcon,
  log: logIcon,
  pdf: pdfIcon,
  zip: zipIcon,
  tar: zipIcon,
  gz: zipIcon,
  bz2: zipIcon,
  xz: zipIcon,
  // Images
  png: imageIcon,
  jpg: imageIcon,
  jpeg: imageIcon,
  gif: imageIcon,
  bmp: imageIcon,
  svg: imageIcon,
  webp: imageIcon,
  ico: imageIcon,
  avif: imageIcon,
  // Video
  mp4: videoIcon,
  webm: videoIcon,
  mov: videoIcon,
  avi: videoIcon,
  mkv: videoIcon,
  // Audio
  mp3: audioIcon,
  wav: audioIcon,
  ogg: audioIcon,
  flac: audioIcon,
  m4a: audioIcon,
  // Fonts
  ttf: fontIcon,
  otf: fontIcon,
  woff: fontIcon,
  woff2: fontIcon,
  // Binary / lib
  so: libIcon,
  dll: libIcon,
  dylib: libIcon,
  a: libIcon,
  lib: libIcon,
  pem: keyIcon,
  key: keyIcon,
  crt: keyIcon,
  lock: lockIcon,
};

/** Special folder names that get a more specific icon. */
export const BY_FOLDER_NAME: Record<string, [string, string] | undefined> = {
  // [closed, open]
  ".git": [gitIcon, gitIcon],
  ".github": [gitIcon, gitIcon],
  ".vscode": [vscodeIcon, vscodeIcon],
  ".idea": [vscodeIcon, vscodeIcon],
  node_modules: [npmIcon, npmIcon],
};
