#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes("--check");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function write(path, content) {
  writeFileSync(join(root, path), content);
}

function eolOf(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function withEol(content, eol) {
  return content.replace(/\r?\n/g, eol);
}

function update(path, next) {
  const before = read(path);
  next = withEol(next, eolOf(before));
  if (before === next) return [];
  if (check) return [path];
  write(path, next);
  return [];
}

const pkg = JSON.parse(read("package.json"));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`package.json version is not semver-like: ${version}`);
}

const mismatches = [];

const lock = JSON.parse(read("package-lock.json"));
lock.version = version;
lock.packages[""].version = version;
mismatches.push(
  ...update("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`),
);

mismatches.push(
  ...update(
    "src-tauri/tauri.conf.json",
    read("src-tauri/tauri.conf.json").replace(
      /("version"\s*:\s*)"[^"]+"/,
      `$1"${version}"`,
    ),
  ),
);

mismatches.push(
  ...update(
    "src-tauri/Cargo.toml",
    read("src-tauri/Cargo.toml").replace(
      /(^\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
      `$1"${version}"`,
    ),
  ),
);

mismatches.push(
  ...update(
    "src-tauri/Cargo.lock",
    read("src-tauri/Cargo.lock").replace(
      /(\[\[package\]\]\r?\nname = "aethon"\r?\nversion = )"[^"]+"/,
      `$1"${version}"`,
    ),
  ),
);

if (mismatches.length > 0) {
  console.error(
    `Version files are out of sync with package.json (${version}):\n` +
      mismatches.map((path) => `  - ${path}`).join("\n") +
      "\nRun `bun run version:sync`.",
  );
  process.exit(1);
}

if (!check) {
  console.log(`Synced version ${version}`);
}
