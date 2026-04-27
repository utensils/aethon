/**
 * Pi extension example — adds a "Recent Files" sidebar section populated
 * from `git log` and wires clicks to a `ctx.pi.prompt("read <file>…")`
 * turn so the agent shows the file contents in the canvas.
 *
 * Demonstrates the right pattern for workspace-aware sidebar sections:
 * the bridge has zero opinions about what files matter; the extension
 * reads from git, the user's pin list, an LSP, etc., and registers the
 * section. Aethon ships no default Files panel — install this (or your
 * own) to opt in.
 *
 * Install: copy or symlink into `~/.pi/agent/extensions/`.
 */

/// <reference path="./aethon-types.d.ts" />

import { execFileSync } from "node:child_process";

interface PiExtensionApi {
  registerCommand?(name: string, options: unknown): void;
}

const MAX_FILES = 10;

// Pull files touched by the most recent commits, deduped, capped.
// Falls back to an empty list outside a git repo so installation
// doesn't break in a fresh project.
function recentGitFiles(cwd: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["log", "--name-only", "--pretty=format:", "-30"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const seen = new Set<string>();
    const list: string[] = [];
    for (const raw of out.split("\n")) {
      const path = raw.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      list.push(path);
      if (list.length >= MAX_FILES) break;
    }
    return list;
  } catch {
    return [];
  }
}

export default function (_api: PiExtensionApi): void {
  if (!globalThis.aethon) return;
  const aethon = globalThis.aethon;

  const files = recentGitFiles(process.cwd());
  if (files.length === 0) {
    // Skip registration entirely outside a git repo — leaving an empty
    // section labeled "Recent Files" is worse than no section at all.
    return;
  }

  // Use the file path as the item id so the click handler can read it
  // straight off the event without a side lookup.
  aethon.registerSidebarSection({
    id: "recent-files",
    title: "Recent Files",
    items: files.map((path) => ({ id: path, label: path })),
  });

  aethon.onEvent(
    { componentType: "sidebar", eventType: "select" },
    async (event, ctx) => {
      const data = event.data as { sectionId?: string; itemId?: string } | undefined;
      if (data?.sectionId !== "recent-files" || !data.itemId) return;
      const path = data.itemId;
      ctx.pi.notify(`Opening ${path}…`);
      // Hand the request to the agent: it'll use pi's read tool, the
      // result lands as a tool card in the canvas. The system prompt
      // already tells the agent to render code in cards; this just
      // gives it a clean trigger.
      await ctx.pi.prompt(
        `Read \`${path}\` and show its contents. Don't explain unless I ask.`,
      );
    },
  );
}
