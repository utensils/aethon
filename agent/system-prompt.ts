/**
 * Aethon-awareness system prompt — appended to pi's default system prompt
 * so the agent knows it's running inside a GUI and can mutate that GUI
 * directly without an LLM round-trip.
 *
 * The prompt is composed at runtime from three layers (priority high → low):
 *   1. ~/.aethon/system-prompt.md            — full override (replaces base)
 *   2. ~/.aethon/system-prompt-append.md     — appended after base
 *   3. DEFAULT_AETHON_PROMPT                 — base, always emitted
 *
 * On top of those layers we always inject a **runtime snapshot** describing
 * what's currently loaded (extensions, themes, registered components, the
 * active layout, tabs, environment paths). The snapshot is rebuilt every
 * time the bridge calls resolveAethonSystemPrompt(), so registrations and
 * tab changes show up in the prompt on the next session.reload().
 *
 * Aethon-only — does not ship to the standalone pi CLI.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger";
import { DEFAULT_AETHON_PROMPT } from "./system-prompt/prompt-template";
import type { RuntimeSnapshot } from "./system-prompt/types";

export type { RuntimeSnapshot };

// Build the runtime-state section that gets appended to the static base
// prompt. Compact by design — the agent can read $AETHON_STATE_FILE for
// the full data; this is just enough to answer "what's loaded?" without
// a tool call.
/**
 * Build the "Available subagents" advertisement appended to the system prompt.
 * Injected per-turn by the `before_agent_start` hook (not via the static
 * snapshot) so it reflects the *active tab's* cwd — tabs on different projects
 * see different subagents. Returns "" when none are configured.
 */
export function buildSubagentsSection(
  subagents: {
    name: string;
    description: string;
    model?: string;
    surface: "inline" | "tab";
  }[],
): string {
  if (subagents.length === 0) return "";
  const lines: string[] = [
    "# Available subagents",
    "Delegate focused work to one with the `task` tool " +
      '(`task({ subagent_type: "<name>", prompt: "<self-contained task>" })`) ' +
      "or to several independent subagents with `task_batch`. " +
      "Choose the subagent whose description best fits; pass everything it needs " +
      "in `prompt` (it runs in an isolated session and sees only that). Multiple " +
      "leading mentions such as `@a and @b ...` mean the whole prompt should fan " +
      'out with `task_batch` and `surface: "inline"` by default. Use ' +
      '`surface: "background"` only when the user asks for async/background/' +
      "don't-wait/separate-tabs behavior. Non-leading mentions (e.g. \"when " +
      'done, have @<name> review") are guidance to delegate just that part, not ' +
      "an automatic whole-prompt hijack. Do NOT delegate trivial work you can do " +
      "directly.",
  ];
  for (const s of subagents) {
    const model = s.model ? `, model \`${s.model}\`` : "";
    const tab = s.surface === "tab" ? ", opens its own tab" : "";
    lines.push(`- \`${s.name}\`${model}${tab} — ${s.description}`);
  }
  return lines.join("\n");
}

function runtimeModelList(
  snapshot: RuntimeSnapshot,
): { id: string; label?: string }[] {
  const uiState = snapshot.uiState as {
    "/sidebar/models"?: unknown;
    sidebar?: unknown;
  };
  const sidebar = uiState.sidebar;
  const models =
    uiState["/sidebar/models"] ??
    (sidebar && typeof sidebar === "object"
      ? (sidebar as { models?: unknown }).models
      : undefined);
  if (!Array.isArray(models)) return [];
  return models
    .map((model) => {
      if (!model || typeof model !== "object") return null;
      const rec = model as { id?: unknown; label?: unknown };
      if (typeof rec.id !== "string" || rec.id.length === 0) return null;
      return {
        id: rec.id,
        ...(typeof rec.label === "string" && rec.label.length > 0
          ? { label: rec.label }
          : {}),
      };
    })
    .filter((model): model is { id: string; label?: string } => model !== null);
}

export function buildRuntimeSection(snapshot: RuntimeSnapshot): string {
  const lines: string[] = ["# Current runtime snapshot"];
  lines.push(
    `Build: ${snapshot.release ? "release" : "dev"}. Agent host dir: \`${snapshot.cwd}\` — ` +
      "this is where the bridge process launched, NOT necessarily where any tab " +
      "operates. Each turn's authoritative working directory + git state arrives in the " +
      '"Working context" section appended below; trust that over this line.',
  );
  if (snapshot.projectRoot) {
    lines.push(
      `Source guard: active — writes to \`${snapshot.projectRoot}/{src,src-tauri,agent}/\` are blocked.`,
    );
  }
  if (snapshot.docsDir) {
    lines.push(`Docs: \`${snapshot.docsDir}\`.`);
  }
  lines.push(`State file: \`${snapshot.stateFile}\`.`);
  lines.push("");

  if (snapshot.extensions.length === 0) {
    lines.push("Loaded extensions: none.");
  } else {
    lines.push("Loaded extensions:");
    for (const ext of snapshot.extensions) {
      lines.push(`- \`${ext.name}\` (${ext.source})`);
    }
  }

  if (snapshot.failedExtensions && snapshot.failedExtensions.length > 0) {
    lines.push("");
    lines.push(
      "Extensions that did NOT load (parse / register() errors or skipped). The user sees these as SYSTEM banners in chat; you do too, here. If you authored or just edited one of these and the next user message is about it, treat the failure as your problem to fix — read the file, identify the cause from the error, and propose a corrected version. Don't ask the user whether it loaded; this list is the answer.",
    );
    for (const ext of snapshot.failedExtensions) {
      const where = ext.path ? ` at \`${ext.path}\`` : "";
      lines.push(
        `- \`${ext.name}\` (${ext.source}, ${ext.status})${where} — ${ext.error}`,
      );
    }
  }

  if (snapshot.themes.length > 0) {
    lines.push("");
    lines.push(
      "Registered themes (in addition to the built-in ember / paper / aether / brink palettes):",
    );
    for (const t of snapshot.themes) {
      lines.push(`- \`${t.id}\` — ${t.label}`);
    }
  }

  if (snapshot.components.length > 0) {
    lines.push("");
    lines.push(
      `Registered custom A2UI component types: ${snapshot.components
        .map((c) => `\`${c}\``)
        .join(", ")}.`,
    );
  }

  if (snapshot.slashCommands.length > 0) {
    lines.push("");
    lines.push("Extension-registered slash commands:");
    for (const c of snapshot.slashCommands) {
      const usage = c.usage ? ` ${c.usage}` : "";
      lines.push(
        `- \`/${c.name}${usage}\` — ${c.description || "(no description)"}`,
      );
    }
  }

  if ((snapshot.piSlashCommands ?? []).length > 0) {
    lines.push("");
    lines.push("Available pi slash commands (handled by pi):");
    for (const c of snapshot.piSlashCommands ?? []) {
      const usage = c.usage ? ` ${c.usage}` : "";
      const source = c.source ? ` [${c.source}]` : "";
      lines.push(
        `- \`/${c.name}${usage}\`${source} — ${c.description || "(no description)"}`,
      );
    }
  }

  if (snapshot.keybindings.length > 0) {
    lines.push("");
    lines.push(
      "Extension-registered keybindings (registered combos run before built-ins and can override them):",
    );
    for (const k of snapshot.keybindings) {
      const desc = k.description ? ` — ${k.description}` : "";
      lines.push(`- \`${k.combo}\` → action \`${k.action}\`${desc}`);
    }
  }

  if (snapshot.menuItems.length > 0) {
    lines.push("");
    lines.push("Extension-registered menu items:");
    for (const m of snapshot.menuItems) {
      const parent = m.parent ? ` under \`${m.parent}\`` : "";
      lines.push(
        `- [${m.location}] \`${m.label}\` → action \`${m.action}\`${parent}`,
      );
    }
  }

  if (
    snapshot.eventRoutes.length > 0 ||
    snapshot.eventRoutingMode !== "builtin"
  ) {
    lines.push("");
    lines.push(
      `Extension event routing mode: ${snapshot.eventRoutingMode}. Intercept routes:`,
    );
    for (const r of snapshot.eventRoutes) {
      lines.push(
        `- componentId=\`${r.componentId ?? "*"}\` eventType=\`${r.eventType ?? "*"}\``,
      );
    }
    if (snapshot.eventRoutes.length === 0) lines.push("- (none)");
  }

  if (snapshot.eventHandlers.length > 0) {
    lines.push("");
    lines.push("Active onEvent handlers (match-shape only):");
    for (const h of snapshot.eventHandlers) {
      const parts: string[] = [];
      if (h.templateRootType)
        parts.push(`templateRootType=${h.templateRootType}`);
      if (h.componentType) parts.push(`componentType=${h.componentType}`);
      if (h.descendantId) parts.push(`descendantId=${h.descendantId}`);
      if (h.eventType) parts.push(`eventType=${h.eventType}`);
      if (h.surfaceId) parts.push(`surfaceId=${h.surfaceId}`);
      if (h.windowId) parts.push(`windowId=${h.windowId}`);
      lines.push(
        `- ${parts.length ? parts.join(", ") : "(matches everything)"}`,
      );
    }
  }

  const nativeWindows = snapshot.nativeWindows ?? [];
  if (nativeWindows.length > 0) {
    lines.push("");
    lines.push("Open native A2UI canvas windows:");
    for (const w of nativeWindows) {
      const tab = w.tabId ? `, owner tab \`${w.tabId}\`` : "";
      const count =
        typeof w.componentCount === "number"
          ? `, ${w.componentCount} components`
          : "";
      lines.push(`- \`${w.id}\` — "${w.title}" (${w.kind}${tab}${count})`);
    }
  }

  const models = runtimeModelList(snapshot);
  if (models.length > 0) {
    lines.push("");
    lines.push(
      "Available model ids for task launch/model switching. Use these exact provider-qualified ids; bare names like `gpt-5.5` are invalid:",
    );
    for (const model of models) {
      const label = model.label ? ` — ${model.label}` : "";
      lines.push(`- \`${model.id}\`${label}`);
    }
  }

  const uiKeys = Object.keys(snapshot.uiState);
  if (uiKeys.length > 0) {
    lines.push("");
    lines.push(
      "Frontend-mirrored state (what's currently visible — read via `aethon.getFrontendState(path)`):",
    );
    for (const key of uiKeys.sort()) {
      const value = snapshot.uiState[key];
      // Single-line JSON preview, truncated so the snapshot stays
      // skimmable. Full data lives in $AETHON_STATE_FILE.
      let preview = JSON.stringify(value);
      if (preview && preview.length > 200) {
        preview = preview.slice(0, 197) + "…";
      }
      lines.push(`- \`${key}\` = ${preview}`);
    }
  }

  lines.push("");
  lines.push(`Active layout: ${snapshot.layoutSummary}.`);
  if (snapshot.layoutStructure) {
    const ls = snapshot.layoutStructure;
    lines.push(
      `Root \`${ls.rootId}\` (\`${ls.rootType}\`) — children: ${
        ls.children
          .map((c) =>
            c.area
              ? `\`${c.id}\`(\`${c.type}\` @ ${c.area})`
              : `\`${c.id}\`(\`${c.type}\`)`,
          )
          .join(", ") || "(none)"
      }.`,
    );
  }
  if (snapshot.layoutSlots) {
    // One-liner — the full catalogue lives in the bundled
    // extensions/default-layout/slots.json (and in components.md). Here we
    // just surface the slot names so the agent knows what semantic
    // areas the standard composites slot into. `area: "<name>"` on a
    // child is the contract.
    const slotNames = Object.keys(snapshot.layoutSlots.slots);
    if (slotNames.length > 0) {
      lines.push(
        `Layout slots (canonical area names): ${slotNames
          .map((n) => `\`${n}\``)
          .join(", ")}. See bundled \`components.md\` for the full contract.`,
      );
    }
  }

  if (snapshot.tabs.length > 0) {
    lines.push("");
    lines.push("Open tabs:");
    for (const t of snapshot.tabs) {
      const cwdNote = t.cwd ? `, cwd \`${t.cwd}\`` : "";
      lines.push(
        `- \`${t.id}\` — model \`${t.model || "(none)"}\`, ${t.messageCount} messages${cwdNote}`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the Aethon system prompt fragments. Layered as:
 *   1. \`~/.aethon/system-prompt.md\` — full override (replaces DEFAULT)
 *   2. \`~/.aethon/system-prompt-append.md\` — concatenated after DEFAULT
 *   3. DEFAULT only
 *
 * The runtime snapshot is appended last in every case so the agent always
 * sees an up-to-date view of what's loaded.
 *
 * Returns the strings to append to pi's default system prompt. The bridge
 * passes these into \`DefaultResourceLoader\`'s \`appendSystemPrompt\` option
 * so they survive every resourceLoader.reload().
 */
export function resolveAethonSystemPrompt(snapshot: RuntimeSnapshot): string[] {
  const dir = join(homedir(), ".aethon");
  const overridePath = join(dir, "system-prompt.md");
  const appendPath = join(dir, "system-prompt-append.md");
  let override: string | undefined;
  let extra: string | undefined;
  try {
    override = readFileSync(overridePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("prompt")
        .warn(`read ${overridePath}: ${(err as Error).message}`);
    }
  }
  try {
    extra = readFileSync(appendPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger
        .scope("prompt")
        .warn(`read ${appendPath}: ${(err as Error).message}`);
    }
  }
  const base = override?.trim() || DEFAULT_AETHON_PROMPT;
  const runtime = buildRuntimeSection(snapshot);
  const layers = extra?.trim()
    ? [base, extra.trim(), runtime]
    : [base, runtime];
  return layers;
}
