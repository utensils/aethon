// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { readFileSync } from "node:fs";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { dirname, join } from "node:path";
// @ts-expect-error - app tsconfig omits Node types; Vitest runs this file in Node.
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function readStyleFile(relativePath: string): string {
  return readFileSync(join(here, relativePath), "utf8");
}

export function readAggregatedChromeCss(): string {
  const entry = readStyleFile("chrome.css");

  return entry.replaceAll(
    /@import\s+["']\.\/chrome\/([^"']+)["'];/g,
    (_match: string, fileName: string) => readStyleFile(`chrome/${fileName}`),
  );
}
