import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findProjectExtensionDirs } from "./project-extensions";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aethon-project-ext-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findProjectExtensionDirs", () => {
  it("walks from cwd to git root and returns extension dirs root-first", async () => {
    const root = await tempRoot();
    const app = join(root, "packages", "app");
    const rootExt = join(root, ".aethon", "extensions");
    const appExt = join(app, ".aethon", "extensions");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(rootExt, { recursive: true });
    await mkdir(appExt, { recursive: true });

    await expect(findProjectExtensionDirs(app)).resolves.toEqual([
      { projectRoot: root, extensionDir: rootExt },
      { projectRoot: root, extensionDir: appExt },
    ]);
  });

  it("only checks cwd when no git root exists", async () => {
    const root = await tempRoot();
    const child = join(root, "child");
    const rootExt = join(root, ".aethon", "extensions");
    await mkdir(child, { recursive: true });
    await mkdir(rootExt, { recursive: true });

    await expect(findProjectExtensionDirs(child)).resolves.toEqual([]);
  });

  it("normalizes file cwd values to their parent directory", async () => {
    const root = await tempRoot();
    const src = join(root, "src");
    const ext = join(root, ".aethon", "extensions");
    const file = join(src, "main.ts");
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(src, { recursive: true });
    await mkdir(ext, { recursive: true });
    await writeFile(file, "export {};\n");

    await expect(findProjectExtensionDirs(file)).resolves.toEqual([
      { projectRoot: root, extensionDir: ext },
    ]);
  });
});
