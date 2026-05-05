import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RegisteredPiSkill } from "./state";
import { logger } from "./logger";

function readFrontmatterField(body: string, field: string): string | undefined {
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const line = m[1]
    .split(/\r?\n/)
    .find((l) => l.trimStart().startsWith(`${field}:`));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!value) return undefined;
  return value.replace(/^['"]|['"]$/g, "");
}

function fallbackDescription(body: string): string {
  const withoutFrontmatter = body.replace(/^---\n[\s\S]*?\n---\n?/, "");
  for (const line of withoutFrontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
  }
  return "Pi skill";
}

export async function discoverPiSkills(
  skillsDir = join(homedir(), ".pi", "agent", "skills"),
): Promise<RegisteredPiSkill[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      logger.scope("pi-skills").warn(`readdir ${skillsDir}: ${(err as Error).message}`);
    }
    return [];
  }

  const out: RegisteredPiSkill[] = [];
  for (const entry of entries.sort()) {
    if (!/^[A-Za-z][\w-]*$/.test(entry)) continue;
    try {
      const body = await readFile(join(skillsDir, entry, "SKILL.md"), "utf8");
      const name = readFrontmatterField(body, "name") ?? entry;
      if (!/^[A-Za-z][\w-]*$/.test(name)) continue;
      const description =
        readFrontmatterField(body, "description") ?? fallbackDescription(body);
      const usage = readFrontmatterField(body, "argument-hint");
      out.push({
        name,
        description,
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        logger
          .scope("pi-skills")
          .warn(`read ${join(skillsDir, entry, "SKILL.md")}: ${(err as Error).message}`);
      }
    }
  }
  return out;
}
